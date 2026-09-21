/**
 * The server-mode {@link ProjectWorkspaceProvider} (ADR-040).
 *
 * This is what makes the HTTP API and the remote MCP server run *the same*
 * application service as the browser. `DocumentationWorkspace.over(provider)`
 * does not know whether a project is a directory or a row plus a volume; this
 * adapter answers with the server's answer, so every read, index, diagnostic and
 * revision check above it is shared code.
 *
 * Two properties it must not lose:
 *
 * - **It is built for one caller.** The {@link ApplicationContext} is captured
 *   at construction, and every project it lists or opens has already been
 *   authorized for that principal. A provider is never shared between requests.
 * - **It never invents a path.** A project's storage directory comes from the
 *   factory, keyed by a project id that came out of the database — never from a
 *   request.
 */
import type { ApplicationContext } from "../application/context";
import type {
  ProjectWorkspace,
  ProjectWorkspaceProvider,
} from "../application/ports";
import type { ProjectCatalog } from "../application/project-catalog";
import type { ProjectStorage } from "../application/project-storage";
import type { ProjectRepository } from "./project-repository";
import { createServerWorkspaceRepository } from "./server-workspace-repository";
import type { ServerProject } from "../domain/project/server-project";
import type { Project } from "../domain/workspace/types";

/** A project's content store and where it lives. */
export interface ProjectStorageLocation {
  storage: ProjectStorage;
  root: string;
}

/** Options for the server workspace provider. */
export interface ServerWorkspaceProviderOptions {
  context: ApplicationContext;
  catalog: ProjectCatalog;
  /** Resource identity and revisions, shared with the catalog. */
  projects: ProjectRepository;
  /**
   * Where a project's files live.
   *
   * The provider asks this for a project it has already authorized, so the
   * factory never sees untrusted input.
   */
  location: (projectId: string) => ProjectStorageLocation;
}

/** Map a server project onto the shared domain shape. */
function toDomainProject(project: ServerProject): Project {
  return { id: project.id, name: project.name, datasetIds: [] };
}

/** A provider that answers from PostgreSQL and the project volume. */
export function createServerWorkspaceProvider(
  options: ServerWorkspaceProviderOptions,
): ProjectWorkspaceProvider {
  const { context, catalog, projects, location } = options;

  return {
    describe(): string {
      return "server";
    },

    async listProjects(): Promise<Project[]> {
      const listings = await catalog.listProjects(context);
      return listings.map((listing) => toDomainProject(listing.project));
    },

    async openProject(project: Project): Promise<ProjectWorkspace | null> {
      // Reading the project is what authorizes it: a principal that cannot see
      // it gets the same "no project with that id" every other operation gives.
      let listing;
      try {
        listing = await catalog.getProject(context, project.id);
      } catch {
        return null;
      }
      const { storage, root } = location(listing.project.id);
      return {
        project: toDomainProject(listing.project),
        repo: createServerWorkspaceRepository({
          projectId: listing.project.id,
          storage,
          resources: projects,
        }),
        root,
      };
    },

    async createProject(name: string): Promise<Project | null> {
      const listing = await catalog.createProject(context, { name });
      return toDomainProject(listing.project);
    },
  };
}
