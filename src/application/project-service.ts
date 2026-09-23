/**
 * The application service layer.
 *
 * Everything here is an operation on a project that does not know React exists:
 * read a project and its identity record, keep that record in step with the
 * files, build the index, resolve a reference, rename something. The React shell
 * orchestrates these — it does not own them — which is what makes the same
 * operations available to an export job, a test, or the MCP server this project
 * is being prepared for.
 *
 * Services return {@link Result} rather than throwing, like the repository they
 * sit above, so a caller can surface a failure without a `try`/`catch` in the
 * middle of a render.
 */
import {
  reconcileMetadata,
  renameResourcePath,
  setResourceTitle,
  type MetadataFile,
  type ProjectMetadata,
} from "../domain/workspace/metadata";
import {
  resourceClassificationOf,
  resourceKindOf,
  resourceTypeOfName,
} from "../domain/workspace/resource-id";
import type { DiagramFile, NoteFile, Project } from "../domain/workspace/types";
import { diagramDisplayName } from "../language/diagram-title";
import { noteDisplayName } from "../language/markdown/note-title";
import { err, isOk, ok, type Result } from "../shared/result/result";
import type { WorkspaceRepository } from "../workspace/WorkspaceRepository";
import type { ProjectSourceFile } from "../domain/project/indexer";
import type { ResourceDescriptor } from "../domain/project/project-index";

/** A project's files and identity record, read together. */
export interface ProjectSnapshot {
  project: Project;
  metadata: ProjectMetadata;
  diagrams: DiagramFile[];
  notes: NoteFile[];
  /**
   * Whether reading the project had to migrate the identity record — for
   * example the first time a project created before ids existed is opened.
   */
  migrated: boolean;
  /** Ids minted during that migration, for a one-off report to the user. */
  assigned: Array<{ id: string; path: string }>;
}

/** The identity record's view of one stored file. */
function metadataFileFor(file: DiagramFile | NoteFile): MetadataFile {
  const isNote = "markdown" in file;
  return {
    path: file.name,
    // A note is a markdown document whatever it is called — an in-browser note
    // may not carry `.md`, and the store it came from is authoritative. A
    // diagram needs its name: the extension is what separates an event flow
    // from a sequence diagram (ADR-028), and using the store kind alone would
    // record every event flow as a sequence diagram and mis-analyse it.
    type: isNote ? "markdown-document" : resourceTypeOfName(file.name),
    title: isNote
      ? noteDisplayName(file.name, file.markdown)
      : diagramDisplayName(file.name, file.source),
  };
}

/**
 * Read a project: its files, and the identity record that gives them stable ids.
 *
 * The record is reconciled against the files that actually exist and written
 * back when it changed. That single step is the whole migration story: a project
 * that predates ids gains them on first open, a project whose files were added
 * or removed from outside the app catches up, and a project that is already in
 * step costs one read.
 */
export async function loadProjectSnapshot(
  repo: WorkspaceRepository,
  project: Project,
): Promise<Result<ProjectSnapshot, Error>> {
  const [diagramsResult, notesResult, metadataResult] = await Promise.all([
    repo.listDiagramFiles(project.id),
    repo.listNoteFiles(project.id),
    repo.readProjectMetadata(project.id),
  ]);
  if (!isOk(diagramsResult)) return diagramsResult;
  if (!isOk(notesResult)) return notesResult;
  if (!isOk(metadataResult)) return metadataResult;

  const diagrams = diagramsResult.value;
  const notes = notesResult.value;
  const stored = metadataResult.value;

  const reconciled = reconcileMetadata(stored, [
    ...diagrams.map(metadataFileFor),
    ...notes.map(metadataFileFor),
  ]);

  if (reconciled.changed) {
    const written = await repo.writeProjectMetadata(
      project.id,
      reconciled.metadata,
    );
    if (!isOk(written)) return written;
  }

  return ok({
    project,
    metadata: reconciled.metadata,
    diagrams,
    notes,
    migrated: stored === null || reconciled.assigned.length > 0,
    assigned: reconciled.assigned,
  });
}

/**
 * Record a rename in the identity record, preserving the id.
 *
 * A rename is the operation the whole stable-id design exists for: the file
 * moves, documentation does not. Called before or after the repository performs
 * the move — both orders converge, because the record is keyed by the old path
 * until this runs.
 */
export async function recordResourceRename(
  repo: WorkspaceRepository,
  projectId: string,
  metadata: ProjectMetadata,
  fromPath: string,
  toPath: string,
): Promise<Result<ProjectMetadata, Error>> {
  const next = renameResourcePath(metadata, fromPath, toPath);
  if (next === metadata) return ok(metadata);
  const written = await repo.writeProjectMetadata(projectId, next);
  if (!isOk(written)) return written;
  return ok(next);
}

/** Record a resource's new display title in the identity record. */
export async function recordResourceTitle(
  repo: WorkspaceRepository,
  projectId: string,
  metadata: ProjectMetadata,
  path: string,
  title: string,
): Promise<Result<ProjectMetadata, Error>> {
  const next = setResourceTitle(metadata, path, title);
  if (next === metadata) return ok(metadata);
  const written = await repo.writeProjectMetadata(projectId, next);
  if (!isOk(written)) return written;
  return ok(next);
}

/** The descriptor for a stored file, given the project's identity record. */
export function descriptorFor(
  file: DiagramFile | NoteFile,
  metadata: ProjectMetadata,
  projectId: string,
): ResourceDescriptor | null {
  const isNote = "markdown" in file;
  const record = metadata.resources.find((entry) => entry.path === file.name);
  if (!record) return null;
  const type = record.type ?? resourceTypeOfName(file.name);
  return {
    id: record.id,
    projectId,
    path: file.name,
    ...resourceClassificationOf(type),
    // The record knows the type; a file the record has not seen yet still gets
    // one from its name, so a newly created event flow is never mistyped.
    type,
    title: isNote
      ? noteDisplayName(file.name, file.markdown)
      : diagramDisplayName(file.name, file.source),
  };
}

/**
 * The indexer inputs for a snapshot: one entry per resource whose identity the
 * record knows. A file with no record is skipped rather than given a synthetic
 * id, because an unstable id is worse than a missing one — it would silently
 * resolve links to the wrong place. {@link loadProjectSnapshot} reconciles first,
 * so in practice every file has a record.
 */
export function toSourceFiles(
  projectId: string,
  diagrams: DiagramFile[],
  notes: NoteFile[],
  metadata: ProjectMetadata,
): ProjectSourceFile[] {
  const files: ProjectSourceFile[] = [];
  for (const diagram of diagrams) {
    const descriptor = descriptorFor(diagram, metadata, projectId);
    if (descriptor) files.push({ descriptor, content: diagram.source });
  }
  for (const note of notes) {
    const descriptor = descriptorFor(note, metadata, projectId);
    if (descriptor) files.push({ descriptor, content: note.markdown });
  }
  return files;
}

/** The resource type a stored file kind maps onto, for callers building links. */
export { resourceKindOf };

/** A failure with a human-readable message, for a service that has no Result. */
export function serviceError(message: string): Error {
  return new Error(message);
}

/** Wrap a plain error message in a failed {@link Result}. */
export function fail<T>(message: string): Result<T, Error> {
  return err(serviceError(message));
}
