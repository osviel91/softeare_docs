/**
 * The project persistence port.
 *
 * This interface used to live under `src/persistence`, which made the
 * application layer import *from* the layer that implements it — the arrow
 * pointing the wrong way. Projects, memberships and resource records all live
 * behind this one port because they share one invariant: a project's authority is
 * its membership rows, and no query that returns a project for a user may ignore
 * them. Keeping the three together is what makes "list the projects I can see" a
 * single statement rather than three a caller has to remember to join.
 *
 * Resource *content* is not here — it is on the project volume, behind
 * `ProjectStorage`. This port owns resource identity: the id, the validated path,
 * the type, and the revision that optimistic concurrency reads and writes.
 *
 * The implementation (`createProjectRepository` over a `SqlClient`) lives in
 * `src/persistence`, and the dependency points at this file.
 */
import type {
  ProjectListing,
  ProjectMember,
  ServerProject,
} from "../../domain/project/server-project";
import type { ProjectRole } from "../../domain/access/permissions";
import type { ResourceType } from "../../domain/workspace/resource-id";
import type { Result } from "../../shared/result/result";

/** A resource row: the server's record of one stored document. */
export interface ResourceRecord {
  id: string;
  projectId: string;
  /** A validated, project-relative, `/`-separated path. */
  path: string;
  type: ResourceType;
  /** The optimistic-concurrency token. Starts at 1. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/** What a caller must supply to record a new resource. */
export interface NewResource {
  path: string;
  type: ResourceType;
  /** The id to use; omitted means "mint one". */
  id?: string;
}

/** How a write may fail on a stale revision. */
export interface RevisionMismatch {
  expectedRevision: number;
  currentRevision: number;
}

export interface ProjectRepository {
  /** Create a project and make its creator the OWNER member. */
  create(input: {
    ownerId: string;
    workspaceId?: string;
    name: string;
    slug?: string;
  }): Promise<ServerProject>;

  /** Find a project by its authoritative id. */
  findById(id: string): Promise<ServerProject | null>;

  /** Find a project by its owner-scoped slug. */
  findBySlug(ownerId: string, slug: string): Promise<ServerProject | null>;

  /**
   * Every project the user can see — owned or shared — with the user's role and
   * the project's resource count, newest first.
   */
  listForUser(userId: string, workspaceId?: string): Promise<ProjectListing[]>;

  /** Rename a project (and optionally change its slug). */
  update(
    id: string,
    changes: { name?: string; slug?: string },
  ): Promise<ServerProject>;

  /** Delete a project; its members and resource rows go with it. */
  delete(id: string): Promise<void>;

  /** The user's role in a project, or `null` when they are not a member. */
  roleOf(projectId: string, userId: string): Promise<ProjectRole | null>;

  /** Add a member, or change an existing member's role. */
  setMember(
    projectId: string,
    userId: string,
    role: ProjectRole,
  ): Promise<ProjectMember>;

  /** Remove a member. */
  removeMember(projectId: string, userId: string): Promise<void>;

  /** Every member of a project, owners first. */
  listMembers(projectId: string): Promise<ProjectMember[]>;

  /** Every resource a project records, in path order. */
  listResources(projectId: string): Promise<ResourceRecord[]>;

  /** One resource by id, scoped to its project. */
  findResource(
    projectId: string,
    resourceId: string,
  ): Promise<ResourceRecord | null>;

  /** One resource by validated path, scoped to its project. */
  findResourceByPath(
    projectId: string,
    path: string,
  ): Promise<ResourceRecord | null>;

  /** Record a new resource at revision 1. */
  createResource(
    projectId: string,
    resource: NewResource,
  ): Promise<ResourceRecord>;

  /**
   * Bump a resource's revision if the caller saw the current one.
   *
   * Returns the new revision, or a {@link RevisionMismatch} describing what the
   * database actually holds — the value a caller needs to build a `409`.
   */
  bumpRevision(
    projectId: string,
    resourceId: string,
    expectedRevision: number,
  ): Promise<Result<ResourceRecord, RevisionMismatch>>;

  /** Change a resource's path, bumping its revision. */
  moveResource(
    projectId: string,
    resourceId: string,
    newPath: string,
    expectedRevision: number,
  ): Promise<Result<ResourceRecord, RevisionMismatch>>;

  /** Forget a resource. Its file is removed by the caller. */
  deleteResource(projectId: string, resourceId: string): Promise<void>;
}
