/**
 * The workspace persistence contract (Phase 4).
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
 */
import type {
  DiagramFile,
  Project,
  WorkspaceSnapshot,
} from "../domain/workspace/types";
import type {
  DiagramFileId,
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

  /** Delete a project and all of its diagram files. */
  deleteProject(id: ProjectId): Promise<Result<void, Error>>;

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

  /** Remove a diagram file from a project. */
  deleteDiagramFile(
    projectId: ProjectId,
    diagramId: DiagramFileId,
  ): Promise<Result<void, Error>>;

  /** Capture the entire workspace as an immutable snapshot (for export). */
  listAll(): Promise<Result<WorkspaceSnapshot, Error>>;
}
