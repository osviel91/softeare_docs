/**
 * The local-mode {@link ProjectWorkspaceProvider}.
 *
 * A directory whose subdirectories are projects — the same model a folder
 * opened in the browser app uses (ADR-005). This provider is what the stdio MCP
 * server and the tests open, and it is the reference implementation of the port:
 * the server provider adds authentication, a project registry and revision
 * checks, but the *shape* of a project workspace is defined here.
 *
 * It deliberately owns the one thing `DocumentationWorkspace` no longer knows:
 * how a project id becomes a directory. Local project ids *are* directory paths
 * (ADR-005), so resolution is an identity function over a resolved root.
 */
import path from "node:path";
import type { ProjectWorkspace, ProjectWorkspaceProvider } from "./ports";
import type { Project } from "../domain/workspace/types";
import type { FsDirectoryHandle } from "../workspace/fs-access/fs-access-adapter";
import { createFileSystemWorkspaceRepository } from "../workspace/fs-access/file-system-workspace-repository";

/**
 * Build a directory-handle for a filesystem root.
 *
 * Supplied by the host (the MCP server passes its `node-fs` adapter) so this
 * module — and therefore the whole application layer — stays free of `node:fs`.
 */
export type DirectoryHandleFactory = (root: string) => FsDirectoryHandle;

/** A provider over one directory of projects. */
export function createLocalWorkspaceProvider(
  root: string,
  createDirectoryHandle: DirectoryHandleFactory,
): ProjectWorkspaceProvider {
  const resolvedRoot = path.resolve(root);
  const repo = createFileSystemWorkspaceRepository(
    createDirectoryHandle(resolvedRoot),
  );

  return {
    describe(): string {
      return resolvedRoot;
    },

    async listProjects(): Promise<Project[]> {
      const result = await repo.listProjects();
      if (!result.ok) throw result.error;
      return result.value;
    },

    async openProject(project: Project): Promise<ProjectWorkspace | null> {
      // A local project's id is its directory path inside the root (ADR-005).
      // Refusing anything outside keeps a crafted id from addressing a sibling
      // tree, even though local mode trusts its caller.
      const target = path.resolve(resolvedRoot, project.id);
      const prefix = resolvedRoot.endsWith(path.sep)
        ? resolvedRoot
        : resolvedRoot + path.sep;
      if (target !== resolvedRoot && !target.startsWith(prefix)) return null;
      return { project, repo, root: target };
    },

    async createProject(name: string): Promise<Project | null> {
      const result = await repo.createProject(name);
      if (!result.ok) throw result.error;
      return result.value;
    },
  };
}
