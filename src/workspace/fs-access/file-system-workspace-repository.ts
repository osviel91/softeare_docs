/**
 * File System Access API implementation of {@link WorkspaceRepository} (Phase 5).
 *
 * A folder the user opens on their machine *is* the workspace. The domain model
 * maps losslessly onto the folder:
 *
 * - A {@link Project} is a subdirectory of the opened folder. Its id is that
 *   directory's path relative to the folder root (normalized with `/`).
 * - A {@link DiagramFile} is a file inside a project directory. Its id is the
 *   file's path relative to the folder root, e.g. `onboarding/welcome.seq`.
 *
 * Because the filesystem is the source of truth, ids are derived from paths
 * rather than generated — opening the same folder twice yields the same ids, so
 * the explorer's selection and any exported snapshot stay stable. The
 * repository holds no cache: every operation reads the current directory tree,
 * so files dropped in from outside or edits made elsewhere appear immediately.
 *
 * The repository never touches the real File System Access API directly; it
 * depends only on {@link FsDirectoryHandle} (see `fs-access-adapter.ts`), which
 * is what makes it testable in jsdom with a fake directory tree.
 */
import type {
  DiagramFile,
  Project,
  WorkspaceSnapshot,
} from "../../domain/workspace/types";
import type { Result } from "../../shared/result/result";
import { err, ok } from "../../shared/result/result";
import type { WorkspaceRepository } from "../WorkspaceRepository";
import type { FsDirectoryHandle, FsFileHandle } from "./fs-access-adapter";

/** A directory handle paired with its path relative to the folder root. */
interface DirWithPath {
  handle: FsDirectoryHandle;
  /** Path of `handle` relative to the opened folder, `/`-separated. */
  relPath: string;
}

/** Normalize any path: drop empty segments and rejoin with `/`. */
function normalize(relPath: string): string {
  return relPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/");
}

/** Join path pieces into a single normalized relative path. */
function joinRel(...segments: string[]): string {
  return normalize(segments.join("/"));
}

/** Turn any unexpected error into a plain, serializable Error. */
function toRepoError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Build a {@link WorkspaceRepository} over a single opened folder.
 *
 * @param root - The folder the user chose. All project and diagram paths are
 *   computed relative to it; the root itself is never a project.
 */
export function createFileSystemWorkspaceRepository(
  root: FsDirectoryHandle,
): WorkspaceRepository {
  /** Recursively gather every subdirectory of `dir` with its root-relative path. */
  async function collectDirs(
    dir: FsDirectoryHandle,
    relPath: string,
  ): Promise<DirWithPath[]> {
    const found: DirWithPath[] = [];
    for (const [name, entry] of await dir.entries()) {
      if (entry.kind !== "directory") continue;
      const childRel = joinRel(relPath, name);
      found.push({ handle: entry, relPath: childRel });
      found.push(...(await collectDirs(entry, childRel)));
    }
    return found;
  }

  /**
   * Walk from the root down through `relPath`, creating any missing intermediate
   * directories, and return the parent directory plus the final path segment.
   * The final segment is either a file to write or a directory to remove.
   */
  async function resolveParent(
    relPath: string,
  ): Promise<{ dir: FsDirectoryHandle; name: string }> {
    const segments = normalize(relPath).split("/");
    if (segments.length === 0) {
      throw new Error(`Cannot resolve a path relative to the folder root`);
    }
    const name = segments.pop() as string;
    let dir = root;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }
    return { dir, name };
  }

  /**
   * Navigate from the root down to the directory at `relPath`, creating any
   * missing intermediate directories, and return that directory handle.
   */
  async function resolveDir(relPath: string): Promise<FsDirectoryHandle> {
    let dir = root;
    for (const segment of normalize(relPath).split("/")) {
      dir = await dir.getDirectoryHandle(segment);
    }
    return dir;
  }

  /** List every project (subdirectory), deepest first so nested folders sort last. */
  async function listProjects(): Promise<Result<Project[], Error>> {
    try {
      const dirs = await collectDirs(root, "");
      // Sort by path length descending so a parent directory appears after its
      // children; the explorer renders them in this order.
      dirs.sort((a, b) => b.relPath.length - a.relPath.length);
      return ok(
        dirs.map((dir) => ({
          id: dir.relPath,
          name: dir.handle.name,
          datasetIds: [],
        })),
      );
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Load one project by its root-relative path, or `null` when it is absent. */
  async function getProject(
    id: string,
  ): Promise<Result<Project | null, Error>> {
    try {
      const normalized = normalize(id);
      if (normalized === "") return ok(null);
      const dirs = await collectDirs(root, "");
      const match = dirs.find((dir) => dir.relPath === normalized);
      if (!match) return ok(null);
      return ok({
        id: match.relPath,
        name: match.handle.name,
        datasetIds: [],
      });
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /**
   * A project cannot be "created" on a real folder — the directory already
   * exists on disk. This method materializes an empty project directory (and its
   * parents) so the explorer can immediately save diagrams into it.
   */
  async function createProject(name: string): Promise<Result<Project, Error>> {
    try {
      const relPath = normalize(name);
      if (relPath === "")
        return err(new Error("Project name must not be empty"));
      // Resolve the parent of the final segment (creating intermediate dirs) and
      // then create the project directory itself.
      const segments = relPath.split("/");
      const dirName = segments.pop() as string;
      const { dir } = await resolveParent(relPath);
      await dir.getDirectoryHandle(dirName);
      return ok({ id: relPath, name: dirName, datasetIds: [] });
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Remove a project directory and everything beneath it. */
  async function deleteProject(id: string): Promise<Result<void, Error>> {
    try {
      const normalized = normalize(id);
      if (normalized === "")
        return err(new Error("Cannot delete the folder root"));
      const segments = normalized.split("/");
      if (segments.length === 1) {
        await root.removeEntry(segments[0]);
        return ok(undefined);
      }
      // Navigate to the parent directory, then remove the final segment.
      const { dir, name } = await resolveParent(normalized);
      await dir.removeEntry(name);
      return ok(undefined);
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Enumerate the diagram files of a project directory, in display order. */
  async function listDiagramFiles(
    projectId: string,
  ): Promise<Result<DiagramFile[], Error>> {
    try {
      const normalized = normalize(projectId);
      if (normalized === "") return ok([]);
      let dir: FsDirectoryHandle;
      try {
        dir = await resolveDir(normalized);
      } catch {
        // The project directory does not exist yet; it simply has no files.
        return ok([]);
      }
      const files: DiagramFile[] = [];
      for (const [name, entry] of await dir.entries()) {
        if (entry.kind !== "file") continue;
        files.push({
          id: joinRel(normalized, name),
          name,
          source: await entry.getFile(),
          projectId: normalized,
        });
      }
      return ok(files);
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Load one diagram file from a project by its root-relative path. */
  async function getDiagramFile(
    projectId: string,
    diagramId: string,
  ): Promise<Result<DiagramFile | null, Error>> {
    try {
      const dirPath = normalize(projectId);
      const relPath = normalize(diagramId);
      if (dirPath === "" || relPath === "") return ok(null);
      // A diagram belongs to the project only when its path lives under it.
      if (!relPath.startsWith(`${dirPath}/`)) return ok(null);
      const { dir, name } = await resolveParent(relPath);
      let file: FsFileHandle;
      try {
        file = await dir.getFileHandle(name);
      } catch {
        return ok(null);
      }
      return ok({
        id: relPath,
        name: file.name,
        source: await file.getFile(),
        projectId: dirPath,
      });
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Write (create or overwrite) a diagram file's source on disk. */
  async function saveDiagramFile(
    projectId: string,
    diagram: DiagramFile,
  ): Promise<Result<DiagramFile, Error>> {
    try {
      const dirPath = normalize(projectId);
      if (dirPath === "")
        return err(new Error("Diagram must belong to a project"));
      // The authoritative id is the on-disk path; ignore any mismatched caller id.
      const relPath = joinRel(dirPath, diagram.name);
      const { dir, name } = await resolveParent(relPath);
      // `createIfNotExists` lets save create a new diagram file, not just overwrite.
      const writable = await dir
        .getFileHandle(name, { createIfNotExists: true })
        .then((handle) => handle.createWritable());
      try {
        await writable.write(new TextEncoder().encode(diagram.source));
      } finally {
        await writable.close();
      }
      return ok({
        id: relPath,
        name: diagram.name,
        source: diagram.source,
        projectId: dirPath,
      });
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Remove a single diagram file from a project. */
  async function deleteDiagramFile(
    projectId: string,
    diagramId: string,
  ): Promise<Result<void, Error>> {
    try {
      const dirPath = normalize(projectId);
      const relPath = normalize(diagramId);
      if (dirPath === "" || relPath === "") return ok(undefined);
      if (!relPath.startsWith(`${dirPath}/`)) return ok(undefined);
      const { dir, name } = await resolveParent(relPath);
      await dir.removeEntry(name);
      return ok(undefined);
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Capture the whole workspace: every project and its files. */
  async function listAll(): Promise<Result<WorkspaceSnapshot, Error>> {
    try {
      const projects = await listProjects();
      if (!projects.ok) return projects;
      const diagrams: DiagramFile[] = [];
      for (const project of projects.value) {
        const files = await listDiagramFiles(project.id);
        if (!files.ok) return files;
        diagrams.push(...files.value);
      }
      return ok({ projects: projects.value, diagrams });
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  return {
    listProjects,
    getProject,
    createProject,
    deleteProject,
    listDiagramFiles,
    getDiagramFile,
    saveDiagramFile,
    deleteDiagramFile,
    listAll,
  };
}
