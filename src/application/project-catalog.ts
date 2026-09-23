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
import { actorIdOf, actorTypeOf, credentialIdOf } from "./context";
import { ApplicationError, forbidden, invalid, notFound } from "./errors";
import type {
  ProjectListing,
  ServerProject,
} from "../domain/project/server-project";
import { slugify } from "../domain/project/server-project";
import type { Permission, ProjectRole } from "../domain/access/permissions";
import {
  createAuthorizationPolicy,
  credentialGrants,
  grantedPermissions,
  restrictionOf,
  type AuthorizationPolicy,
} from "./authorization";
import type {
  ProjectRepository,
  ResourceRecord,
} from "./ports/project-repository";
import type { ProjectStorage } from "./project-storage";
import { InvalidResourcePathError } from "./ports/resource-path";
import type { AuditAction, AuditRepository } from "./ports/audit-repository";
import type { WorkspaceOperationRepository } from "./ports/workspace-operation-repository";
import type { WorkspaceRepository } from "./ports/workspace-repository";
import {
  createWorkspaceMutationService,
  type ResourceView,
  type WorkspaceMutationService,
} from "./workspace-mutations";
import type { JsonObject } from "../shared/json/json-value";

/**
 * A resource as the API and MCP surface it: identity, path, type, revision.
 *
 * Structurally the mutation service's {@link ResourceView}; named here because
 * this is the vocabulary every host already imports.
 */
export type CatalogResource = ResourceView;

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
  workspaces: WorkspaceRepository;
  storage: ProjectStorageFactory;
  audit?: AuditRepository;
  /**
   * The durable operation journal every resource mutation commits through.
   *
   * Supplying it is what turns a mutation into the Phase 6 sequence — claim the
   * revision, journal the intent, promote the staged bytes, settle — rather than
   * a check followed by a write. A test or a host that omits it gets a service
   * that refuses resource mutations rather than one that silently falls back to
   * the racy path.
   */
  operations?: WorkspaceOperationRepository;
  /** A pre-built mutation service, for a host that shares one with its provider. */
  mutations?: WorkspaceMutationService;
  /** Content digest for the journal's staging verification. */
  hashContent?: (content: string) => string;
  /**
   * The authorization policy. Injectable so a test can prove a use case refuses
   * when the policy does — and so a different deployment can supply a different
   * policy without any use case changing.
   */
  policy?: AuthorizationPolicy<ServerProject>;
  /**
   * Called when an audit entry could not be written.
   *
   * Project and membership mutations still write their audit entry after the
   * change, because their whole change is one database transaction that the
   * audit row cannot join through this port. Resource mutations no longer take
   * this path at all: their audit row commits *with* the change, inside the
   * operation journal's transaction.
   */
  onAuditFailure?: (error: unknown, event: AuditFailureContext) => void;
}

/** What a failed audit write was trying to record. */
export interface AuditFailureContext {
  action: AuditAction;
  subjectUserId: string;
  projectId: string | null;
  resourceId: string | null;
  requestId: string;
}

/** The default reporter: one line on stderr, with the correlation id. */
function reportAuditFailure(error: unknown, event: AuditFailureContext): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${event.requestId} audit ${event.action} failed: ${message}\n`,
  );
}

/** The server project use cases. */
export interface ProjectCatalog {
  /** Every project the caller is a member of, newest first. */
  listProjects(
    context: ApplicationContext,
    workspaceId: string,
  ): Promise<ProjectListing[]>;

  /** The caller's default workspace, for hosts without a workspace selector. */
  defaultWorkspaceId(context: ApplicationContext): Promise<string>;

  /** One project and the caller's role in it. */
  getProject(
    context: ApplicationContext,
    projectId: string,
  ): Promise<ProjectListing>;

  /** Create a project, its membership and its storage directory. */
  createProject(
    context: ApplicationContext,
    input: { name: string; workspaceId: string; slug?: string },
  ): Promise<ProjectListing>;

  /**
   * What the caller may do in this project.
   *
   * A browser needs this to render the right affordances, and an agent uses it
   * to decide whether a write is worth attempting. It is *advisory*: every
   * operation re-checks, so a stale or forged answer here grants nothing.
   */
  describeAccess(
    context: ApplicationContext,
    projectId: string,
  ): Promise<{
    projectId: string;
    role: ProjectRole;
    permissions: readonly Permission[];
  }>;

  /**
   * Whether the caller may perform `permission` in this project.
   *
   * The non-throwing form of the same decision every use case makes, for an
   * adapter that must ask *before* it offers an operation rather than after it
   * fails — the server workspace provider uses it to make a read-only caller's
   * repository genuinely read-only, so a write cannot slip past the policy by
   * arriving through the shared documentation service instead of the catalog.
   */
  can(
    context: ApplicationContext,
    projectId: string,
    permission: Permission,
  ): Promise<boolean>;

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

  /**
   * Create a resource, refusing a path that is already taken.
   *
   * `idempotencyKey` is optional; when present, a retry with the same key by the
   * same actor in the same project returns the first result instead of creating a
   * second resource.
   */
  createResource(
    context: ApplicationContext,
    projectId: string,
    input: {
      path: string;
      type: ResourceRecord["type"];
      content: string;
      idempotencyKey?: string;
    },
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
    input: {
      content: string;
      expectedRevision: number;
      idempotencyKey?: string;
    },
  ): Promise<CatalogResource>;

  /** Move a resource to another path, keeping its id. */
  moveResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    input: {
      path: string;
      expectedRevision: number;
      idempotencyKey?: string;
    },
  ): Promise<CatalogResource>;

  /** Delete a resource's file and its record. */
  deleteResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    input?: { expectedRevision?: number; idempotencyKey?: string },
  ): Promise<void>;
}

/**
 * Run a path-addressed operation, reporting a refused path as `invalid`.
 *
 * The path boundary throws (`InvalidResourcePathError`) rather than returning a
 * `Result`, because a traversal attempt is a programming or hostile input error,
 * not a value a caller branches on. Translating it here is what keeps that
 * detail out of every transport.
 *
 * Resource mutations now take this path inside the mutation service; this
 * re-export keeps the translation available to the project-level use cases that
 * still run here.
 */
export async function withPath<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InvalidResourcePathError) {
      // The `kind` is machine-readable on purpose: a transport can tell "this
      // path is not allowed" from an ordinary validation failure without
      // parsing an English message, and an MCP agent can act on it.
      throw invalid(error.message, { kind: "invalid_path" });
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
  const { projects, workspaces, storage, audit } = options;
  const policy =
    options.policy ?? createAuthorizationPolicy<ServerProject>(projects);

  /**
   * The one authoritative resource-mutation path (Phase 6 §25–33).
   *
   * A host may inject a pre-built service so the catalog and the documentation
   * provider cannot end up with two; otherwise it is built here from the same
   * repositories. A host that supplies neither gets a catalog that refuses
   * resource mutations loudly rather than a second, racy implementation.
   */
  const mutations: WorkspaceMutationService | null =
    options.mutations ??
    (options.operations === undefined
      ? null
      : createWorkspaceMutationService({
          projects,
          storage,
          operations: options.operations,
          policy,
          ...(options.hashContent === undefined
            ? {}
            : { hashContent: options.hashContent }),
        }));

  /** The mutation service, or a refusal that names the misconfiguration. */
  const requireMutations = (): WorkspaceMutationService => {
    if (mutations === null) {
      throw new ApplicationError(
        "internal",
        "This deployment has no workspace operation journal, so resource mutations are disabled.",
      );
    }
    return mutations;
  };

  /**
   * Authorize an operation, then hand back the project it acted on.
   *
   * The permission is named, not a role list: the mapping from role to
   * capability lives in `src/domain/access/permissions.ts` and is applied by the
   * policy, so a use case never asks "is this user an editor?".
   */
  const requirePermission = async (
    context: ApplicationContext,
    projectId: string,
    permission: Permission,
  ): Promise<{ project: ServerProject; role: ProjectRole }> => {
    const grant = await policy.requirePermission(
      context,
      projectId,
      permission,
    );
    // The policy resolved the project on the way to its decision, so there is no
    // second read here and no window in which the row could change underneath it.
    const workspaceRole = await workspaces.roleOf(
      grant.project.workspaceId,
      context.principal.subjectUserId,
    );
    if (workspaceRole === null) {
      throw notFound(`No project with id ${projectId}.`);
    }
    return { project: grant.project, role: grant.role };
  };

  const requireWorkspaceMember = async (
    context: ApplicationContext,
    workspaceId: string,
  ): Promise<void> => {
    const role = await workspaces.roleOf(
      workspaceId,
      context.principal.subjectUserId,
    );
    if (role === null) throw notFound(`No workspace with id ${workspaceId}.`);
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
    const failureContext: AuditFailureContext = {
      action: event.action,
      subjectUserId: context.principal.subjectUserId,
      projectId: event.projectId ?? null,
      resourceId: event.resourceId ?? null,
      requestId: context.requestId,
    };
    try {
      await audit.record({
        action: event.action,
        // The subject is the user whose authority bounded the request; the
        // actor is who actually asked. For a session they coincide; for an
        // agent credential they differ, and the trail must show both.
        subjectUserId: context.principal.subjectUserId,
        actorType: actorTypeOf(context.principal),
        actorId: actorIdOf(context.principal),
        credentialId: credentialIdOf(context.principal),
        authType: context.principal.authType,
        projectId: event.projectId ?? null,
        resourceId: event.resourceId ?? null,
        requestId: context.requestId,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      });
    } catch (error) {
      // The mutation has already committed. Reporting a failure here would be
      // false, and swallowing it silently would hide a compliance problem, so it
      // is reported and the successful mutation stands.
      (options.onAuditFailure ?? reportAuditFailure)(error, failureContext);
    }
  };

  return {
    async listProjects(context, workspaceId) {
      await requireWorkspaceMember(context, workspaceId);
      const listings = await projects.listForUser(
        context.principal.subjectUserId,
        workspaceId,
      );
      const restricted = restrictionOf(context.principal);
      if (restricted === null) return listings;
      return listings.filter((entry) => restricted.includes(entry.project.id));
    },

    async defaultWorkspaceId(context) {
      const workspace = (
        await workspaces.listForUser(context.principal.subjectUserId)
      ).find((entry) => entry.isDefault);
      if (!workspace) throw notFound("No default workspace is available.");
      return workspace.id;
    },

    async getProject(context, projectId) {
      const { project, role } = await requirePermission(
        context,
        projectId,
        "project:read",
      );
      const listing = (
        await projects.listForUser(
          context.principal.subjectUserId,
          project.workspaceId,
        )
      ).find((entry) => entry.project.id === project.id);
      return {
        project,
        role,
        resourceCount: listing?.resourceCount ?? 0,
      };
    },

    async describeAccess(context, projectId) {
      const { role } = await requirePermission(
        context,
        projectId,
        "project:read",
      );
      // Both grants are reported, not just the role's: a read-only agent token
      // whose user happens to own the project must not be told it may write.
      const permissions = grantedPermissions(role).filter((permission) =>
        credentialGrants(context.principal, permission),
      );
      return { projectId, role, permissions };
    },

    async can(context, projectId, permission) {
      const outcome = await policy.decide(context, projectId, permission);
      return outcome.allowed;
    },

    async createProject(context, input) {
      // There is no project to resolve a role in yet, so the credential's own
      // capability is the whole check. A session carries the full vocabulary; a
      // read-only machine token does not, which keeps project creation a
      // privileged act.
      if (!credentialGrants(context.principal, "project:create")) {
        throw forbidden(
          "This credential does not carry the project:create permission.",
        );
      }
      const name = input.name.trim();
      if (name === "") throw invalid("A project name is required.");
      await requireWorkspaceMember(context, input.workspaceId);
      const project = await projects.create({
        ownerId: context.principal.subjectUserId,
        workspaceId: input.workspaceId,
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
      await requirePermission(context, projectId, "project:update");
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
      await requirePermission(context, projectId, "project:delete");
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
      await requirePermission(context, projectId, "project:members:write");
      await projects.setMember(projectId, userId, role);
      await writeAudit(context, {
        action: "project.member.added",
        projectId: projectId,
      });
    },

    async removeMember(context, projectId, userId) {
      const { project } = await requirePermission(
        context,
        projectId,
        "project:members:write",
      );
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
      await requirePermission(context, projectId, "resource:read");
      const records = await projects.listResources(projectId);
      return records.map(toCatalogResource);
    },

    async getResource(context, projectId, resourceId) {
      await requirePermission(context, projectId, "resource:read");
      const record = await projects.findResource(projectId, resourceId);
      if (!record) throw notFound(`No resource with id ${resourceId}.`);
      return toCatalogResource(record);
    },

    async readResource(context, projectId, resourceId) {
      await requirePermission(context, projectId, "resource:read");
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

    /**
     * Create a resource through the one authoritative mutation path.
     *
     * Everything below this line — authorization, staging, the revision claim,
     * the durable journal record, the transactional audit row and the final
     * promote — lives in {@link createWorkspaceMutationService}, so the HTTP API,
     * the remote MCP tools and the shared documentation service all get the same
     * sequence rather than three near-copies of it.
     */
    createResource(context, projectId, input) {
      return requireMutations().createResource(context, projectId, input);
    },

    updateResource(context, projectId, resourceId, input) {
      return requireMutations().updateResource(
        context,
        projectId,
        resourceId,
        input,
      );
    },

    moveResource(context, projectId, resourceId, input) {
      return requireMutations().moveResource(
        context,
        projectId,
        resourceId,
        input,
      );
    },

    deleteResource(context, projectId, resourceId, input) {
      return requireMutations().deleteResource(
        context,
        projectId,
        resourceId,
        input ?? {},
      );
    },
  };
}

/** Export the slug rule so an API validator and the catalog agree. */
export { slugify };
