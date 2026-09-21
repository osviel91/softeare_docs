/**
 * File System Access API implementation of {@link WorkspaceRepository} (Phase 5).
 *
 * A folder the user opens on their machine *is* the workspace. The domain model
 * maps losslessly onto the folder:
 *
 * - A {@link Project} is a subdirectory of the opened folder. Its id is that
 *   directory's path relative to the folder root (normalized with `/`).
 * - A {@link DiagramFile} is a non-markdown file inside a project directory. Its
 *   id is the file's path relative to the folder root, e.g. `onboarding/welcome.seq`.
 * - A {@link ProjectMetadata} sidecar lives beside those files as `project.json`
 *   and is reserved, so it is never listed as a diagram.
 * - A {@link NoteFile} is a markdown file (`.md`). Notes and diagrams are told
 *   apart by extension, so a project directory mixes prose and diagrams freely.
 *
 * Because the filesystem is the source of truth, ids are derived from paths
 * rather than generated — opening the same folder twice yields the same ids, so
 * the explorer's selection and any exported snapshot stay stable. The repository
 * holds no cache: every operation reads the current directory tree, so files
 * dropped in from outside or edits made elsewhere appear immediately.
 *
 * The repository never touches the real File System Access API directly; it
 * depends only on {@link FsDirectoryHandle} (see `fs-access-adapter.ts`), which
 * is what makes it testable in jsdom with a fake directory tree.
 */
import type {
  DiagramFile,
  NoteFile,
  Project,
  WorkspaceSnapshot,
} from "../../domain/workspace/types";
import {
  PROJECT_METADATA_FILE_NAME,
  parseProjectMetadata,
  serializeProjectMetadata,
  type ProjectMetadata,
} from "../../domain/workspace/metadata";
import {
  EMPTY_NOTE_MARKDOWN,
  ensureMarkdownExtension,
  uniqueNoteName,
} from "../../domain/workspace/note";
import { uniqueCopyName } from "../../domain/workspace/copy-name";
import {
  EMPTY_DIAGRAM_NAME,
  uniqueDiagramName,
} from "../../domain/workspace/diagram";
import {
  EMPTY_EVENT_FLOW_NAME,
  uniqueEventFlowName,
} from "../../domain/workspace/event-flow";
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

/** True when a file name denotes a markdown note (as opposed to a diagram). */
function isMarkdownName(name: string): boolean {
  return /\.md$/i.test(name);
}

/**
 * The file names a project directory reserves for repository bookkeeping rather
 * than for user content.
 *
 * A folder project mixes content and sidecars in one directory, so any file the
 * repository writes for itself is invisible to enumeration. New reserved files
 * are added here and nowhere else, which is what keeps a future sidecar from
 * leaking into the explorer as a diagram or a note.
 */
const RESERVED_PROJECT_FILE_NAMES: ReadonlySet<string> = new Set([
  PROJECT_METADATA_FILE_NAME,
]);

/** Whether a project-directory entry is repository bookkeeping, not a resource. */
function isReservedProjectFile(name: string): boolean {
  return RESERVED_PROJECT_FILE_NAMES.has(name);
}

/** Turn any unexpected error into a plain, serializable Error. */
function toRepoError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** One shared encoder so repeated file writes stay cheap. */
const utf8 = new TextEncoder();

/**
 * Recursively copy every file and subdirectory of `source` into `target`.
 *
 * The File System Access API has no portable move/rename, so both a file rename
 * and a project rename are expressed as copy-then-delete; this is the directory
 * half of that. Text is preserved exactly because resources are UTF-8 text.
 */
async function copyDirTree(
  source: FsDirectoryHandle,
  target: FsDirectoryHandle,
): Promise<void> {
  for (const [name, entry] of await source.entries()) {
    if (entry.kind === "directory") {
      const child = await target.getDirectoryHandle(name, {
        createIfNotExists: true,
      });
      await copyDirTree(entry, child);
      continue;
    }
    const text = await entry.getFile();
    const file = await target.getFileHandle(name, {
      createIfNotExists: true,
    });
    const writable = await file.createWritable();
    try {
      await writable.write(utf8.encode(text));
    } finally {
      await writable.close();
    }
  }
}

/**
 * Remove a subdirectory and everything in it.
 *
 * The real API only removes an empty directory without its own `recursive`
 * option, so the tree is emptied depth first and the directory itself removed
 * last. That keeps the delete working on every implementation of the adapter.
 */
async function removeDirTree(
  parent: FsDirectoryHandle,
  name: string,
): Promise<void> {
  const dir = await parent.getDirectoryHandle(name);
  for (const [childName, child] of await dir.entries()) {
    if (child.kind === "directory") {
      await removeDirTree(dir, childName);
    } else {
      await dir.removeEntry(childName);
    }
  }
  await parent.removeEntry(name);
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
          noteIds: [],
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
        noteIds: [],
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
      return ok({ id: relPath, name: dirName, datasetIds: [], noteIds: [] });
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
        await removeDirTree(root, segments[0]);
        return ok(undefined);
      }
      // Navigate to the parent directory, then remove the final segment.
      const { dir, name } = await resolveParent(normalized);
      await removeDirTree(dir, name);
      return ok(undefined);
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /**
   * Rename a project by copying its directory to the new name and removing the
   * old one. The File System Access API has no portable move, so — exactly as
   * {@link renameDiagramFile} does for a single file — the repository copies and
   * deletes. A project's id is its path, so the returned project carries a new
   * id and the files beneath it move with the directory.
   */
  async function renameProject(
    id: string,
    newName: string,
  ): Promise<Result<Project, Error>> {
    try {
      const normalized = normalize(id);
      const name = newName.trim();
      if (normalized === "") return err(new Error("Unknown project"));
      if (name === "") return err(new Error("A project name is required"));
      if (name.includes("/") || name.includes("\\")) {
        return err(
          new Error("A project name must not contain a path separator"),
        );
      }

      const segments = normalized.split("/");
      const oldName = segments[segments.length - 1];
      const parentPath = segments.slice(0, -1).join("/");
      const parent = parentPath === "" ? root : await resolveDir(parentPath);

      if (oldName === name) {
        return ok({ id: normalized, name, datasetIds: [], noteIds: [] });
      }

      // Never overwrite a sibling: a name collision is the user's to resolve.
      const siblings = await parent.entries();
      if (siblings.some(([entryName]) => entryName === name)) {
        return err(new Error(`A folder named "${name}" already exists`));
      }

      const source = await parent.getDirectoryHandle(oldName);
      const target = await parent.getDirectoryHandle(name, {
        createIfNotExists: true,
      });
      await copyDirTree(source, target);
      await removeDirTree(parent, oldName);

      return ok({
        id: joinRel(parentPath, name),
        name,
        datasetIds: [],
        noteIds: [],
      });
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /**
   * Read a project's metadata sidecar, or `null` when it is absent or unusable.
   *
   * Absence is the migration signal: a project created before stable ids existed
   * has no sidecar. A malformed or foreign file must not stop the app from
   * opening the project either, so every unreadable case reads as "no metadata"
   * and the caller reconciles a fresh document from the files on disk.
   */
  async function readProjectMetadata(
    projectId: string,
  ): Promise<Result<ProjectMetadata | null, Error>> {
    try {
      const dirPath = normalize(projectId);
      if (dirPath === "") return ok(null);
      let dir: FsDirectoryHandle;
      try {
        dir = await resolveDir(dirPath);
      } catch {
        // The project directory does not exist, so it has no metadata.
        return ok(null);
      }
      let file: FsFileHandle;
      try {
        file = await dir.getFileHandle(PROJECT_METADATA_FILE_NAME);
      } catch {
        // No sidecar yet: a project that predates ids.
        return ok(null);
      }
      const text = await file.getFile();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Malformed JSON is "no metadata", never a failure to open the project.
        return ok(null);
      }
      return ok(parseProjectMetadata(parsed));
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /**
   * Write a project's metadata sidecar, creating the project directory when
   * needed. A folder project has no separate registry — the directory *is* the
   * project — so a write may materialize it, exactly as saving a diagram does.
   */
  async function writeProjectMetadata(
    projectId: string,
    metadata: ProjectMetadata,
  ): Promise<Result<void, Error>> {
    try {
      const dirPath = normalize(projectId);
      if (dirPath === "")
        return err(new Error("Metadata must belong to a project"));
      const relPath = joinRel(dirPath, PROJECT_METADATA_FILE_NAME);
      const { dir, name } = await resolveParent(relPath);
      const writable = await dir
        .getFileHandle(name, { createIfNotExists: true })
        .then((handle) => handle.createWritable());
      try {
        await writable.write(
          new TextEncoder().encode(serializeProjectMetadata(metadata)),
        );
      } finally {
        await writable.close();
      }
      return ok(undefined);
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Enumerate the diagram files of a project directory (non-markdown files). */
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
        // Markdown files are notes, not diagrams; reserved sidecars are neither.
        if (isMarkdownName(name) || isReservedProjectFile(name)) continue;
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

  /**
   * Create an empty diagram on disk inside a project directory. The file is
   * named "Untitled" (or the next free variant) and written with an empty source;
   * it reuses {@link saveDiagramFile} so the file is materialized in one step.
   */
  async function createEmptyDiagram(
    projectId: string,
  ): Promise<Result<DiagramFile, Error>> {
    try {
      const dirPath = normalize(projectId);
      if (dirPath === "")
        return err(new Error("Diagram must belong to a project"));
      const existing = await listDiagramFiles(dirPath);
      if (!existing.ok) return existing;
      const diagram: DiagramFile = {
        id: joinRel(dirPath, EMPTY_DIAGRAM_NAME),
        name: uniqueDiagramName(existing.value.map((entry) => entry.name)),
        source: "",
        projectId: dirPath,
      };
      return await saveDiagramFile(dirPath, diagram);
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /**
   * Create an empty event flow on disk inside a project directory.
   *
   * The file is named `Untitled.eventseq`, so the extension is what marks it as
   * an event flow — the same rule that distinguishes a note (`.md`) from a
   * diagram. It reuses {@link saveDiagramFile}, so the file is materialized in
   * one step.
   */
  async function createEmptyEventFlow(
    projectId: string,
  ): Promise<Result<DiagramFile, Error>> {
    try {
      const dirPath = normalize(projectId);
      if (dirPath === "")
        return err(new Error("An event flow must belong to a project"));
      const existing = await listDiagramFiles(dirPath);
      if (!existing.ok) return existing;
      return await saveDiagramFile(dirPath, {
        id: joinRel(dirPath, EMPTY_EVENT_FLOW_NAME),
        name: uniqueEventFlowName(existing.value.map((entry) => entry.name)),
        source: "",
        projectId: dirPath,
      });
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /**
   * Duplicate a diagram file on disk: the same source under the next free
   * " copy" name, so duplicating never overwrites a sibling.
   */
  async function duplicateDiagramFile(
    projectId: string,
    diagramId: string,
  ): Promise<Result<DiagramFile, Error>> {
    try {
      const dirPath = normalize(projectId);
      const relPath = normalize(diagramId);
      if (dirPath === "" || relPath === "")
        return err(new Error(`Unknown diagram: ${diagramId}`));
      if (!relPath.startsWith(`${dirPath}/`))
        return err(new Error(`Unknown diagram: ${diagramId}`));

      const existing = await getDiagramFile(dirPath, relPath);
      if (!existing.ok) return existing;
      if (!existing.value)
        return err(new Error(`Unknown diagram: ${diagramId}`));

      const siblings = await listDiagramFiles(dirPath);
      if (!siblings.ok) return siblings;
      const name = uniqueCopyName(
        existing.value.name,
        siblings.value.map((entry) => entry.name),
      );
      // `saveDiagramFile` derives the id from the (new, free) file name.
      return await saveDiagramFile(dirPath, { ...existing.value, name });
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

  /** Enumerate the markdown notes of a project directory. */
  async function listNoteFiles(
    projectId: string,
  ): Promise<Result<NoteFile[], Error>> {
    try {
      const normalized = normalize(projectId);
      if (normalized === "") return ok([]);
      let dir: FsDirectoryHandle;
      try {
        dir = await resolveDir(normalized);
      } catch {
        return ok([]);
      }
      const files: NoteFile[] = [];
      for (const [name, entry] of await dir.entries()) {
        if (entry.kind !== "file" || !isMarkdownName(name)) continue;
        if (isReservedProjectFile(name)) continue;
        files.push({
          id: joinRel(normalized, name),
          name,
          markdown: await entry.getFile(),
          projectId: normalized,
        });
      }
      return ok(files);
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Load one note from a project by its root-relative path. */
  async function getNoteFile(
    projectId: string,
    noteId: string,
  ): Promise<Result<NoteFile | null, Error>> {
    try {
      const dirPath = normalize(projectId);
      const relPath = normalize(noteId);
      if (dirPath === "" || relPath === "") return ok(null);
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
        markdown: await file.getFile(),
        projectId: dirPath,
      });
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Write (create or overwrite) a note's markdown on disk. */
  async function saveNoteFile(
    projectId: string,
    note: NoteFile,
  ): Promise<Result<NoteFile, Error>> {
    try {
      const dirPath = normalize(projectId);
      if (dirPath === "")
        return err(new Error("A note must belong to a project"));
      const name = ensureMarkdownExtension(note.name);
      const relPath = joinRel(dirPath, name);
      const { dir, name: leaf } = await resolveParent(relPath);
      const writable = await dir
        .getFileHandle(leaf, { createIfNotExists: true })
        .then((handle) => handle.createWritable());
      try {
        await writable.write(new TextEncoder().encode(note.markdown));
      } finally {
        await writable.close();
      }
      return ok({
        id: relPath,
        name,
        markdown: note.markdown,
        projectId: dirPath,
      });
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Create a markdown note seeded with a heading. */
  async function createEmptyNote(
    projectId: string,
  ): Promise<Result<NoteFile, Error>> {
    try {
      const dirPath = normalize(projectId);
      if (dirPath === "")
        return err(new Error("A note must belong to a project"));
      const existing = await listNoteFiles(dirPath);
      if (!existing.ok) return existing;
      const note: NoteFile = {
        id: "",
        name: uniqueNoteName(existing.value.map((entry) => entry.name)),
        markdown: EMPTY_NOTE_MARKDOWN,
        projectId: dirPath,
      };
      return await saveNoteFile(dirPath, note);
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Duplicate a note on disk: the same markdown under the next free copy name. */
  async function duplicateNoteFile(
    projectId: string,
    noteId: string,
  ): Promise<Result<NoteFile, Error>> {
    try {
      const dirPath = normalize(projectId);
      const relPath = normalize(noteId);
      if (dirPath === "" || relPath === "")
        return err(new Error(`Unknown note: ${noteId}`));
      if (!relPath.startsWith(`${dirPath}/`))
        return err(new Error(`Unknown note: ${noteId}`));

      const existing = await getNoteFile(dirPath, relPath);
      if (!existing.ok) return existing;
      if (!existing.value) return err(new Error(`Unknown note: ${noteId}`));

      const siblings = await listNoteFiles(dirPath);
      if (!siblings.ok) return siblings;
      const name = uniqueCopyName(
        existing.value.name,
        siblings.value.map((entry) => entry.name),
      );
      return await saveNoteFile(dirPath, { ...existing.value, name });
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Remove a single note file from a project. */
  async function deleteNoteFile(
    projectId: string,
    noteId: string,
  ): Promise<Result<void, Error>> {
    try {
      const dirPath = normalize(projectId);
      const relPath = normalize(noteId);
      if (dirPath === "" || relPath === "") return ok(undefined);
      if (!relPath.startsWith(`${dirPath}/`)) return ok(undefined);
      const { dir, name } = await resolveParent(relPath);
      await dir.removeEntry(name);
      return ok(undefined);
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /**
   * Whether a file already exists at `relPath`.
   *
   * `getFileHandle` without `createIfNotExists` rejects when the entry is
   * absent (and when a directory of that name exists), which is exactly the
   * "something is already there" answer a rename needs.
   */
  async function fileExists(relPath: string): Promise<boolean> {
    try {
      const { dir, name } = await resolveParent(relPath);
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Rename a diagram file by writing the same source under the new name and
   * removing the old one. The File System Access API's move support is uneven, so
   * copy-then-delete keeps rename working everywhere (and the repository is the
   * only layer that knows how it is done).
   */
  async function renameDiagramFile(
    projectId: string,
    diagramId: string,
    newName: string,
  ): Promise<Result<DiagramFile, Error>> {
    try {
      const dirPath = normalize(projectId);
      const oldRel = normalize(diagramId);
      const name = newName.trim();
      if (dirPath === "" || oldRel === "")
        return err(new Error("Unknown diagram"));
      if (name === "") return err(new Error("A diagram name is required"));
      if (isMarkdownName(name))
        return err(new Error("A diagram name must not end with .md"));
      if (!oldRel.startsWith(`${dirPath}/`))
        return err(new Error(`Unknown diagram: ${diagramId}`));

      const existing = await getDiagramFile(dirPath, oldRel);
      if (!existing.ok) return existing;
      if (!existing.value)
        return err(new Error(`Unknown diagram: ${diagramId}`));
      if (existing.value.name === name) return ok(existing.value);

      const newRel = joinRel(dirPath, name);
      if (await fileExists(newRel)) {
        return err(new Error(`A file named "${name}" already exists`));
      }
      const written = await saveDiagramFile(dirPath, {
        ...existing.value,
        name,
      });
      if (!written.ok) return written;
      const removed = await deleteDiagramFile(dirPath, oldRel);
      if (!removed.ok) return removed;
      return ok(written.value);
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  /** Rename a note by writing the same markdown under the new name. */
  async function renameNoteFile(
    projectId: string,
    noteId: string,
    newName: string,
  ): Promise<Result<NoteFile, Error>> {
    try {
      const dirPath = normalize(projectId);
      const oldRel = normalize(noteId);
      const trimmed = newName.trim();
      if (dirPath === "" || oldRel === "")
        return err(new Error("Unknown note"));
      if (trimmed === "") return err(new Error("A note name is required"));
      if (!oldRel.startsWith(`${dirPath}/`))
        return err(new Error(`Unknown note: ${noteId}`));

      const existing = await getNoteFile(dirPath, oldRel);
      if (!existing.ok) return existing;
      if (!existing.value) return err(new Error(`Unknown note: ${noteId}`));

      const name = ensureMarkdownExtension(trimmed);
      if (existing.value.name === name) return ok(existing.value);

      const newRel = joinRel(dirPath, name);
      if (await fileExists(newRel)) {
        return err(new Error(`A file named "${name}" already exists`));
      }
      const written = await saveNoteFile(dirPath, { ...existing.value, name });
      if (!written.ok) return written;
      const removed = await deleteNoteFile(dirPath, oldRel);
      if (!removed.ok) return removed;
      return ok(written.value);
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
      const notes: NoteFile[] = [];
      for (const project of projects.value) {
        const files = await listDiagramFiles(project.id);
        if (!files.ok) return files;
        diagrams.push(...files.value);
        const noteFiles = await listNoteFiles(project.id);
        if (!noteFiles.ok) return noteFiles;
        notes.push(...noteFiles.value);
      }
      return ok({ projects: projects.value, diagrams, notes });
    } catch (error) {
      return err(toRepoError(error));
    }
  }

  return {
    listProjects,
    getProject,
    createProject,
    renameProject,
    deleteProject,
    readProjectMetadata,
    writeProjectMetadata,
    listDiagramFiles,
    getDiagramFile,
    saveDiagramFile,
    createEmptyDiagram,
    createEmptyEventFlow,
    deleteDiagramFile,
    duplicateDiagramFile,
    renameDiagramFile,
    listNoteFiles,
    getNoteFile,
    saveNoteFile,
    createEmptyNote,
    deleteNoteFile,
    duplicateNoteFile,
    renameNoteFile,
    listAll,
  };
}
