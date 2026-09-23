/**
 * The workspace persistence contract.
 *
 * `WorkspaceRepository` is the abstraction both implementations and the UI
 * depend on. It is deliberately framework-free: no React, no browser globals —
 * only the domain model and {@link Result}. This keeps persistence testable in
 * isolation and lets the UI treat expected failures (missing project, save
 * conflict) as values rather than exceptions.
 *
 * All operations are asynchronous because IndexedDB is asynchronous. Every read
 * returns `Result<T, Error>`; writes return `Result<void, Error>` (or the
 * created/updated entity) so callers decide how to surface problems.
 *
 * Invariants the implementations uphold:
 * - A {@link DiagramFile} always belongs to exactly one project.
 * - `Project.datasetIds` lists the ids of the files that belong to it, in order.
 * - Deleting a project removes its diagram files as well (no orphans).
 * - A project's metadata (see {@link ProjectMetadata}) is stored and dropped
 *   with the project, never orphaned.
 */
import type { ProjectMetadata } from "../domain/workspace/metadata";
import type {
  DiagramFile,
  NoteFile,
  Project,
  WorkspaceSnapshot,
} from "../domain/workspace/types";
import type {
  DiagramFileId,
  NoteFileId,
  ProjectId,
} from "../domain/workspace/workspace-ids";
import type { Result } from "../shared/result/result";

export interface WorkspaceRepository {
  /** List every project, in storage order. */
  listProjects(): Promise<Result<Project[], Error>>;

  /** Load a single project by id, or `null` when it does not exist. */
  getProject(id: ProjectId): Promise<Result<Project | null, Error>>;

  /** Create an empty project with a fresh id and the given name. */
  createProject(name: string): Promise<Result<Project, Error>>;

  /**
   * Change a project's display name. Where a project's identity is derived from
   * its directory (the local-folder repository) the returned project carries a
   * new id and the files beneath it move with it; callers must follow it.
   *
   * Implementations refuse an empty name and never overwrite a sibling project.
   */
  renameProject(
    id: ProjectId,
    newName: string,
  ): Promise<Result<Project, Error>>;

  /** Delete a project and all of its diagram and note files. */
  deleteProject(id: ProjectId): Promise<Result<void, Error>>;

  /**
   * Read a project's metadata document, or `null` when it has none yet.
   *
   * A project without metadata is not an error: it is the signal that the
   * project predates stable resource ids, so the caller reconciles one from the
   * files it can see and writes the result back.
   */
  readProjectMetadata(
    projectId: ProjectId,
  ): Promise<Result<ProjectMetadata | null, Error>>;

  /**
   * Write a project's metadata document, replacing any previous one.
   *
   * Writing for a project that does not exist fails instead of silently doing
   * nothing, since a document with no project to belong to would be lost.
   */
  writeProjectMetadata(
    projectId: ProjectId,
    metadata: ProjectMetadata,
  ): Promise<Result<void, Error>>;

  /** List the diagram files belonging to a project, in display order. */
  listDiagramFiles(projectId: ProjectId): Promise<Result<DiagramFile[], Error>>;

  /** Load one diagram file from a project, or `null` when absent. */
  getDiagramFile(
    projectId: ProjectId,
    diagramId: DiagramFileId,
  ): Promise<Result<DiagramFile | null, Error>>;

  /**
   * Insert or replace a diagram file within a project. Adds the file's id to
   * the project when missing and returns the stored copy (which carries the
   * authoritative id and name).
   */
  saveDiagramFile(
    projectId: ProjectId,
    diagram: DiagramFile,
  ): Promise<Result<DiagramFile, Error>>;

  /**
   * Create an empty diagram (fresh id, empty source) inside a project and return
   * the stored copy. The new file is appended to the project's datasetIds so it
   * shows up in the explorer immediately. Returns an error when the project does
   * not exist, since there is nowhere to place the diagram.
   */
  createEmptyDiagram(projectId: ProjectId): Promise<Result<DiagramFile, Error>>;

  /**
   * Create an empty event flow (fresh id, empty source, `.eventseq` name) inside
   * a project and return the stored copy. It lives in the same store as a
   * sequence diagram — the extension is what distinguishes the two languages —
   * so it is appended to the project's datasetIds like any other diagram.
   */
  createEmptyEventFlow(
    projectId: ProjectId,
  ): Promise<Result<DiagramFile, Error>>;

  /**
   * Duplicate a diagram within its project: a new file with the same source and
   * a free name derived from the original (`flow copy`, then `flow copy 2`, ...).
   * Where the id is derived from the file name (the local-folder repository) the
   * returned file carries a fresh id; callers must follow it.
   */
  duplicateDiagramFile(
    projectId: ProjectId,
    diagramId: DiagramFileId,
  ): Promise<Result<DiagramFile, Error>>;

  /** Remove a diagram file from a project. */
  deleteDiagramFile(
    projectId: ProjectId,
    diagramId: DiagramFileId,
  ): Promise<Result<void, Error>>;

  /**
   * Change a diagram file's name. Where the id is derived from the file name
   * (the local-folder repository) the returned file carries a new id; callers
   * must follow it. Implementations refuse to overwrite an existing file.
   */
  renameDiagramFile(
    projectId: ProjectId,
    diagramId: DiagramFileId,
    newName: string,
  ): Promise<Result<DiagramFile, Error>>;

  /** List the markdown notes belonging to a project, in display order. */
  listNoteFiles(projectId: ProjectId): Promise<Result<NoteFile[], Error>>;

  /** Load one note from a project, or `null` when absent. */
  getNoteFile(
    projectId: ProjectId,
    noteId: NoteFileId,
  ): Promise<Result<NoteFile | null, Error>>;

  /** Insert or replace a note within a project, returning the stored copy. */
  saveNoteFile(
    projectId: ProjectId,
    note: NoteFile,
  ): Promise<Result<NoteFile, Error>>;

  /**
   * Create a note seeded with a heading inside a project and return the stored
   * copy. The new file is appended to the project's noteIds.
   */
  createEmptyNote(projectId: ProjectId): Promise<Result<NoteFile, Error>>;

  /**
   * Duplicate a note within its project: a new file with the same markdown and a
   * free name derived from the original (`Untitled copy.md`, ...). The same id
   * caveat as {@link duplicateDiagramFile} applies.
   */
  duplicateNoteFile(
    projectId: ProjectId,
    noteId: NoteFileId,
  ): Promise<Result<NoteFile, Error>>;

  /** Remove a note from a project. */
  deleteNoteFile(
    projectId: ProjectId,
    noteId: NoteFileId,
  ): Promise<Result<void, Error>>;

  /**
   * Change a note's file name, with the same id caveat as
   * {@link renameDiagramFile}.
   */
  renameNoteFile(
    projectId: ProjectId,
    noteId: NoteFileId,
    newName: string,
  ): Promise<Result<NoteFile, Error>>;

  /** Capture the entire workspace as an immutable snapshot (for export). */
  listAll(): Promise<Result<WorkspaceSnapshot, Error>>;
}
