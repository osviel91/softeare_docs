/**
 * The project catalog: server-mode use cases over projects and resources.
 *
 * The server counterpart of "open a project and edit it". It owns the operations
 * that need the database and the project volume together — create a project and
 * its storage directory, list a user's projects with their roles, add a member,
 * rename a resource and keep its record in step — and it is the layer both the
 * HTTP API and the remote MCP server call.
 *
 * Authorization is enforced *here*, not in a controller and not in a tool: the
 * methods take an {@link ApplicationContext} and resolve the caller's role from
 * membership before doing anything. That is what makes it impossible for an MCP
 * tool to reach a project its principal cannot see, however the tool is invoked.
 *
 * Failures are {@link ApplicationError}s with transport-neutral codes, so the
 * API maps `not_found` to a 404 and the MCP adapter maps it to a tool error
 * without either re-deciding what happened.
 */
import type { ApplicationContext } from "./context";
import {
  ApplicationError,
  forbidden,
  invalid,
  notFound,
  revisionConflict,
} from "./errors";
import type {
  ProjectListing,
  ServerProject,
} from "../domain/project/server-project";
import { slugify } from "../domain/project/server-project";
import type { ProjectRole } from "../domain/access/permissions";
import type {
  ProjectRepository,
  ResourceRecord,
} from "../persistence/project-repository";
import type { ProjectStorage } from "./project-storage";
import { InvalidResourcePathError } from "../persistence/resource-path";
import type {
  AuditAction,
  AuditRepository,
} from "../persistence/audit-repository";
import type { JsonObject } from "../shared/json/json-value";

/** A resource as the API and MCP surface it: identity, path, type, revision. */
export interface CatalogResource {
  id: string;
  projectId: string;
  path: string;
  type: ResourceRecord["type"];
  revision: number;
}

/**
 * How to open a project's storage.
 *
 * The catalog never builds a filesystem path from a request: it asks this
 * factory for the store belonging to a project *it has already authorized*, and
 * the factory decides where that project lives (a volume today, an object store
 * later). No caller can pass a path in.
 */
export type ProjectStorageFactory = (projectId: string) => ProjectStorage;

/** What the catalog needs to run. */
export interface ProjectCatalogOptions {
  projects: ProjectRepository;
  storage: ProjectStorageFactory;
  audit?: AuditRepository;
}

/** The server project use cases. */
export interface ProjectCatalog {
  /** Every project the caller is a member of, newest first. */
  listProjects(context: ApplicationContext): Promise<ProjectListing[]>;

  /** One project and the caller's role in it. */
  getProject(
    context: ApplicationContext,
    projectId: string,
  ): Promise<ProjectListing>;

  /** Create a project, its membership and its storage directory. */
  createProject(
    context: ApplicationContext,
    input: { name: string; slug?: string },
  ): Promise<ProjectListing>;

  /** Rename a project, or change its slug. */
  updateProject(
    context: ApplicationContext,
    projectId: string,
    changes: { name?: string; slug?: string },
  ): Promise<ServerProject>;

  /** Delete a project and everything it holds. */
  deleteProject(context: ApplicationContext, projectId: string): Promise<void>;

  /** Add a member or change a member's role. */
  setMember(
    context: ApplicationContext,
    projectId: string,
    userId: string,
    role: ProjectRole,
  ): Promise<void>;

  /** Remove a member. */
  removeMember(
    context: ApplicationContext,
    projectId: string,
    userId: string,
  ): Promise<void>;

  /** Every resource a project records. */
  listResources(
    context: ApplicationContext,
    projectId: string,
  ): Promise<CatalogResource[]>;

  /** One resource's record. */
  getResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
  ): Promise<CatalogResource>;

  /** Read a resource's text. */
  readResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
  ): Promise<{ resource: CatalogResource; content: string }>;

  /** Create a resource, refusing a path that is already taken. */
  createResource(
    context: ApplicationContext,
    projectId: string,
    input: { path: string; type: ResourceRecord["type"]; content: string },
  ): Promise<CatalogResource>;

  /**
   * Replace a resource's text.
   *
   * `expectedRevision` is required: a write that does not say which revision it
   * read is refused rather than allowed to overwrite a concurrent change.
   */
  updateResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    input: { content: string; expectedRevision: number },
  ): Promise<CatalogResource>;

  /** Move a resource to another path, keeping its id. */
  moveResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    input: { path: string; expectedRevision: number },
  ): Promise<CatalogResource>;

  /** Delete a resource's file and its record. */
  deleteResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
  ): Promise<void>;
}

/** The role a caller must hold for a read. */
const READ_ROLES: readonly ProjectRole[] = ["OWNER", "EDITOR", "VIEWER"];
/** The role a caller must hold to change resources. */
const WRITE_ROLES: readonly ProjectRole[] = ["OWNER", "EDITOR"];
/** The role a caller must hold to change the project or its membership. */
const ADMIN_ROLES: readonly ProjectRole[] = ["OWNER"];

/** Whether a credential is restricted to a specific set of projects. */
function restrictionAllows(
  context: ApplicationContext,
  projectId: string,
): boolean {
  const restricted = context.principal.projectIds;
  if (restricted === undefined || restricted.length === 0) return true;
  return restricted.includes(projectId);
}

/**
 * Run a path-addressed operation, reporting a refused path as `invalid`.
 *
 * The path boundary throws (`InvalidResourcePathError`) rather than returning a
 * `Result`, because a traversal attempt is a programming or hostile input error,
 * not a value a caller branches on. Translating it here is what keeps that
 * detail out of every transport.
 */
async function withPath<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InvalidResourcePathError) {
      throw invalid(error.message);
    }
    throw error;
  }
}

/** Map a resource row onto the catalog's view. */
function toCatalogResource(record: ResourceRecord): CatalogResource {
  return {
    id: record.id,
    projectId: record.projectId,
    path: record.path,
    type: record.type,
    revision: record.revision,
  };
}

/** Build the project catalog over a repository, storage factory and audit log. */
export function createProjectCatalog(
  options: ProjectCatalogOptions,
): ProjectCatalog {
  const { projects, storage, audit } = options;

  /** The caller's role, or a failure that does not leak the project's existence. */
  const requireRole = async (
    context: ApplicationContext,
    projectId: string,
    allowed: readonly ProjectRole[],
  ): Promise<{ project: ServerProject; role: ProjectRole }> => {
    const project = await projects.findById(projectId);
    if (!project) throw notFound(`No project with id ${projectId}.`);
    if (!restrictionAllows(context, projectId)) {
      // A project-restricted credential addresses another project: report it as
      // invisible rather than as forbidden, so a token cannot probe for ids.
      throw notFound(`No project with id ${projectId}.`);
    }
    const role = await projects.roleOf(projectId, context.principal.userId);
    if (!role) throw notFound(`No project with id ${projectId}.`);
    if (!allowed.includes(role)) {
      throw forbidden(
        `Your role in this project (${role}) does not permit that operation.`,
      );
    }
    return { project, role };
  };

  const writeAudit = async (
    context: ApplicationContext,
    event: {
      action: AuditAction;
      projectId?: string;
      resourceId?: string;
      detail?: JsonObject;
    },
  ): Promise<void> => {
    if (!audit) return;
    await audit.record({
      action: event.action,
      userId: context.principal.userId,
      authType: context.principal.authType,
      projectId: event.projectId ?? null,
      resourceId: event.resourceId ?? null,
      requestId: context.requestId,
      ...(event.detail === undefined ? {} : { detail: event.detail }),
    });
  };

  const conflict = (
    resourceId: string,
    expectedRevision: number,
    currentRevision: number,
  ): ApplicationError =>
    revisionConflict(
      expectedRevision,
      currentRevision,
      `Resource ${resourceId} changed since it was read: expected revision ${expectedRevision}, current revision ${currentRevision}. Re-read it and retry.`,
    );

  return {
    async listProjects(context) {
      const listings = await projects.listForUser(context.principal.userId);
      const restricted = context.principal.projectIds;
      if (restricted === undefined || restricted.length === 0) return listings;
      return listings.filter((entry) => restricted.includes(entry.project.id));
    },

    async getProject(context, projectId) {
      const { project, role } = await requireRole(
        context,
        projectId,
        READ_ROLES,
      );
      const listing = (
        await projects.listForUser(context.principal.userId)
      ).find((entry) => entry.project.id === project.id);
      return {
        project,
        role,
        resourceCount: listing?.resourceCount ?? 0,
      };
    },

    async createProject(context, input) {
      const name = input.name.trim();
      if (name === "") throw invalid("A project name is required.");
      const project = await projects.create({
        ownerId: context.principal.userId,
        name,
        ...(input.slug === undefined ? {} : { slug: input.slug }),
      });
      // Materialise the storage directory immediately, so the project is a real
      // place to write before the first resource exists.
      await storage(project.id).list();
      await writeAudit(context, {
        action: "project.created",
        projectId: project.id,
      });
      return { project, role: "OWNER", resourceCount: 0 };
    },

    async updateProject(context, projectId, changes) {
      await requireRole(context, projectId, ADMIN_ROLES);
      if (
        changes.slug !== undefined &&
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changes.slug)
      ) {
        throw invalid(
          "A slug must be lower-case letters, digits and single hyphens.",
        );
      }
      const updated = await projects.update(projectId, changes);
      await writeAudit(context, {
        action: "project.updated",
        projectId: projectId,
      });
      return updated;
    },

    async deleteProject(context, projectId) {
      await requireRole(context, projectId, ADMIN_ROLES);
      // The database cascades members and resource rows; the files are removed
      // explicitly, because a volume is not part of a transaction.
      const store = storage(projectId);
      const listed = await store.list();
      if (listed.ok) {
        for (const resource of listed.value) await store.remove(resource.path);
      }
      await projects.delete(projectId);
      await writeAudit(context, {
        action: "project.deleted",
        projectId: projectId,
      });
    },

    async setMember(context, projectId, userId, role) {
      await requireRole(context, projectId, ADMIN_ROLES);
      await projects.setMember(projectId, userId, role);
      await writeAudit(context, {
        action: "project.member.added",
        projectId: projectId,
      });
    },

    async removeMember(context, projectId, userId) {
      const { project } = await requireRole(context, projectId, ADMIN_ROLES);
      if (project.ownerId === userId) {
        throw invalid(
          "The project owner cannot be removed. Transfer ownership first.",
        );
      }
      await projects.removeMember(projectId, userId);
      await writeAudit(context, {
        action: "project.member.removed",
        projectId: projectId,
      });
    },

    async listResources(context, projectId) {
      await requireRole(context, projectId, READ_ROLES);
      const records = await projects.listResources(projectId);
      return records.map(toCatalogResource);
    },

    async getResource(context, projectId, resourceId) {
      await requireRole(context, projectId, READ_ROLES);
      const record = await projects.findResource(projectId, resourceId);
      if (!record) throw notFound(`No resource with id ${resourceId}.`);
      return toCatalogResource(record);
    },

    async readResource(context, projectId, resourceId) {
      await requireRole(context, projectId, READ_ROLES);
      const record = await projects.findResource(projectId, resourceId);
      if (!record) throw notFound(`No resource with id ${resourceId}.`);
      const read = await storage(projectId).read(record.path);
      if (!read.ok) throw read.error;
      if (read.value === null) {
        throw notFound(
          `Resource ${resourceId} is recorded at "${record.path}" but its file is missing.`,
        );
      }
      return {
        resource: toCatalogResource(record),
        content: read.value.content,
      };
    },

    async createResource(context, projectId, input) {
      await requireRole(context, projectId, WRITE_ROLES);
      const existing = await withPath(() =>
        projects.findResourceByPath(projectId, input.path),
      );
      if (existing) {
        throw new ApplicationError(
          "conflict",
          `A resource already exists at "${existing.path}" (id: ${existing.id}).`,
        );
      }
      const written = await storage(projectId).write(input.path, input.content);
      if (!written.ok) throw invalid(written.error.message);
      const record = await projects.createResource(projectId, {
        path: written.value.path,
        type: input.type,
      });
      await writeAudit(context, {
        action: "resource.created",
        projectId,
        resourceId: record.id,
      });
      return toCatalogResource(record);
    },

    async updateResource(context, projectId, resourceId, input) {
      await requireRole(context, projectId, WRITE_ROLES);
      const record = await projects.findResource(projectId, resourceId);
      if (!record) throw notFound(`No resource with id ${resourceId}.`);

      // The revision is claimed *first*, and the file is written inside the same
      // attempt: a stale writer therefore changes nothing at all, and a failed
      // write leaves the revision untouched rather than consuming it.
      const bumped = await projects.bumpRevision(
        projectId,
        resourceId,
        input.expectedRevision,
      );
      if (!bumped.ok) {
        throw conflict(
          resourceId,
          bumped.error.expectedRevision,
          bumped.error.currentRevision,
        );
      }

      const written = await storage(projectId).write(
        record.path,
        input.content,
      );
      if (!written.ok) throw invalid(written.error.message);

      await writeAudit(context, {
        action: "resource.updated",
        projectId,
        resourceId,
      });
      return toCatalogResource(bumped.value);
    },

    async moveResource(context, projectId, resourceId, input) {
      await requireRole(context, projectId, WRITE_ROLES);
      const record = await projects.findResource(projectId, resourceId);
      if (!record) throw notFound(`No resource with id ${resourceId}.`);

      const moved = await withPath(() =>
        storage(projectId).move({ from: record.path, to: input.path }),
      );
      if (!moved.ok)
        throw new ApplicationError("conflict", moved.error.message);

      const updated = await projects.moveResource(
        projectId,
        resourceId,
        moved.value.path,
        input.expectedRevision,
      );
      if (!updated.ok) {
        throw conflict(
          resourceId,
          updated.error.expectedRevision,
          updated.error.currentRevision,
        );
      }
      await writeAudit(context, {
        action: "resource.moved",
        projectId,
        resourceId,
      });
      return toCatalogResource(updated.value);
    },

    async deleteResource(context, projectId, resourceId) {
      await requireRole(context, projectId, WRITE_ROLES);
      const record = await projects.findResource(projectId, resourceId);
      if (!record) throw notFound(`No resource with id ${resourceId}.`);
      const removed = await storage(projectId).remove(record.path);
      if (!removed.ok) throw removed.error;
      await projects.deleteResource(projectId, resourceId);
      await writeAudit(context, {
        action: "resource.deleted",
        projectId,
        resourceId,
      });
    },
  };
}

/** Export the slug rule so an API validator and the catalog agree. */
export { slugify };
