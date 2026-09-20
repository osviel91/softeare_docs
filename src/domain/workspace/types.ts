/**
 * Domain model for projects (Phase 4; notes added in the documentation phase).
 *
 * These types are framework-free and persistence-agnostic: they describe what
 * is stored, not how. The workspace repository (see `src/workspace`) is the
 * only layer that knows about IndexedDB or any other storage.
 *
 * A project is a documentation layer: it holds both {@link DiagramFile}s (DSL
 * source rendered to SVG) and {@link NoteFile}s (markdown documents that may link
 * to its diagrams). Ordering within each collection is preserved explicitly via
 * {@link Project.datasetIds} and {@link Project.noteIds}, so the explorer can
 * render a stable list.
 */

import type { ProjectId } from "./workspace-ids";

/** A single diagram backed by its DSL source. */
export interface DiagramFile {
  /** Stable, unique id within the workspace. */
  id: string;
  /** The display name shown in the explorer (no path separators). */
  name: string;
  /** The DSL source that fully describes the diagram. */
  source: string;
  /** The id of the project this diagram belongs to. Exactly one. */
  projectId: ProjectId;
}

/**
 * A single markdown note. Notes are the prose half of a project: architecture
 * write-ups, runbooks, decision records. A note may link to a diagram with
 * `[[Diagram Name]]`, which the UI resolves to that project's diagrams.
 */
export interface NoteFile {
  /** Stable, unique id within the workspace. */
  id: string;
  /** The file name shown in the explorer (no path separators). */
  name: string;
  /** The markdown body. */
  markdown: string;
  /** The id of the project this note belongs to. Exactly one. */
  projectId: ProjectId;
}

/** An ordered collection of diagram and note files. */
export interface Project {
  /** Stable, unique id within the workspace. */
  id: string;
  /** The display name shown in the explorer. */
  name: string;
  /** Diagram file ids in display order. Kept in sync with stored files. */
  datasetIds: string[];
  /**
   * Note file ids in display order. Optional so a project stored before notes
   * existed still validates; readers treat a missing list as empty.
   */
  noteIds?: string[];
}

/** A full point-in-time view of the workspace: every project and its files. */
export interface WorkspaceSnapshot {
  projects: Project[];
  diagrams: DiagramFile[];
  /** Markdown notes. Absent in snapshots exported before notes existed. */
  notes?: NoteFile[];
}
