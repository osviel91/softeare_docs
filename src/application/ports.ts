/**
 * The workspace seam: how an application service reaches a project's resources.
 *
 * This is the port that makes one documentation implementation serve several
 * hosts. A {@link ProjectWorkspace} bundles the three things an application
 * service needs about a project it has already been authorized for:
 *
 * - the {@link Project} record (its id and display name),
 * - the {@link WorkspaceRepository} over its files (the resource store),
 * - where the project's tree lives, for the few operations that address the
 *   project root rather than a resource (render output today).
 *
 * Local mode resolves those from a directory of projects on disk; server mode
 * resolves them from the `projects` and `resources` tables plus the project's
 * storage volume. Nothing above this port can tell the difference, which is the
 * whole point: the same use case, the same diagnostics, the same revision
 * checks run against either.
 *
 * A provider is the *only* thing that may mint a {@link ProjectWorkspace}. It
 * answers two questions — "which projects can this caller see?" and "give me
 * this one" — and leaves authorization to the caller, so that a policy change
 * is one edit in `src/domain/access/authorize.ts` rather than an edit in every
 * repository implementation.
 */
import type { Project } from "../domain/workspace/types";
import type { WorkspaceRepository } from "../workspace/WorkspaceRepository";

/** A project and the store its resources live in. */
export interface ProjectWorkspace {
  /** The project record. `id` is the authoritative identifier at every edge. */
  project: Project;
  /** The resource store for this project's files. */
  repo: WorkspaceRepository;
  /**
   * The directory the project's tree is rooted at.
   *
   * Local mode: the project's subdirectory. Server mode: the project's storage
   * directory (`/data/projects/<id>`). It is exposed for operations that write
   * beside the resources (an exported artifact) and must never be used to build
   * a client-supplied path.
   */
  root: string;
}

/**
 * A source of project workspaces.
 *
 * @see ProjectWorkspace for why this indirection exists.
 */
export interface ProjectWorkspaceProvider {
  /**
   * Every project the caller may address, in a stable order.
   *
   * A server provider filters this to the caller's memberships; a local provider
   * lists the workspace's subdirectories.
   */
  listProjects(): Promise<Project[]>;

  /**
   * A human-readable name for this workspace, for tool output and logs.
   *
   * Local mode: the workspace directory. Server mode: a stable label such as
   * `server`. It names, it never addresses: no code may turn it into a path.
   */
  describe(): string;

  /** Open one project, or `null` when it does not exist. */
  openProject(project: Project): Promise<ProjectWorkspace | null>;

  /**
   * Create a project and return it, or `null` when the provider does not
   * support creation (a read-only backing volume, for instance).
   */
  createProject(name: string): Promise<Project | null>;
}
