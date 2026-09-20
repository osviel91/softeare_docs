/**
 * Identifier types and generators for workspace entities (Phase 4).
 *
 * Ids must be stable and unique across a workspace's lifetime. As with the
 * diagram ids in `src/shared/ids`, we keep a single production generator and a
 * deterministic test helper so tests stay reproducible.
 */
import { defaultIdFactory } from "../../shared/ids/ids";

/** A stable id for a {@link Project}. */
export type ProjectId = string;

/** A stable id for a {@link DiagramFile}. */
export type DiagramFileId = string;

/** A stable id for a {@link NoteFile}. */
export type NoteFileId = string;

/** Generate a fresh, workspace-unique project id. */
export function newProjectId(): ProjectId {
  return `proj-${defaultIdFactory()}`;
}

/** Generate a fresh, workspace-unique diagram file id. */
export function newDiagramFileId(): DiagramFileId {
  return `diag-${defaultIdFactory()}`;
}

/** Generate a fresh, workspace-unique note file id. */
export function newNoteId(): NoteFileId {
  return `note-${defaultIdFactory()}`;
}

/** Generate a fresh, unique version-history entry id. */
export function newVersionId(): string {
  return `ver-${defaultIdFactory()}`;
}

/**
 * Deterministic id generators for tests. Produce `proj-0`, `diag-0`, ... so
 * project, diagram, and note ids are reproducible across runs.
 */
export function testWorkspaceIdFactory(prefix = "id") {
  let projectCounter = 0;
  let diagramCounter = 0;
  let noteCounter = 0;
  return {
    newProjectId: () => `${prefix}-proj-${projectCounter++}`,
    newDiagramFileId: () => `${prefix}-diag-${diagramCounter++}`,
    newNoteId: () => `${prefix}-note-${noteCounter++}`,
  };
}
