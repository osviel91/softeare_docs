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

/** Generate a fresh, workspace-unique project id. */
export function newProjectId(): ProjectId {
  return `proj-${defaultIdFactory()}`;
}

/** Generate a fresh, workspace-unique diagram file id. */
export function newDiagramFileId(): DiagramFileId {
  return `diag-${defaultIdFactory()}`;
}

/**
 * Deterministic id generators for tests. Produce `proj-0`, `diag-0`, ... so
 * project and diagram ids are reproducible across runs.
 */
export function testWorkspaceIdFactory(prefix = "id") {
  let projectCounter = 0;
  let diagramCounter = 0;
  return {
    newProjectId: () => `${prefix}-proj-${projectCounter++}`,
    newDiagramFileId: () => `${prefix}-diag-${diagramCounter++}`,
  };
}
