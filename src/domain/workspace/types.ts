/**
 * Domain model for in-browser projects (Phase 4).
 *
 * These types are framework-free and persistence-agnostic: they describe what
 * is stored, not how. The workspace repository (see `src/workspace`) is the
 * only layer that knows about IndexedDB or any other store.
 *
 * A {@link DiagramFile} is a single diagram backed by DSL source text — the
 * unit that gets saved, loaded, and rendered. A {@link Project} is an ordered
 * collection of diagram files; ordering is preserved explicitly via
 * {@link Project.datasetIds} so the explorer can render a stable list.
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

/** An ordered collection of diagram files. */
export interface Project {
  /** Stable, unique id within the workspace. */
  id: string;
  /** The display name shown in the explorer. */
  name: string;
  /** Diagram file ids in display order. Kept in sync with stored files. */
  datasetIds: string[];
}

/** A full point-in-time view of the workspace: every project and its files. */
export interface WorkspaceSnapshot {
  projects: Project[];
  diagrams: DiagramFile[];
}
