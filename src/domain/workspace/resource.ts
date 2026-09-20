/**
 * The generic project-resource model (documentation-workspace phase).
 *
 * A project holds more than one kind of file: sequence diagrams (`*.seq`, DSL
 * source) and markdown documents (`*.md`, prose). Everything that treats them
 * uniformly — the tab strip, project-wide search, the portable archive — speaks
 * in terms of {@link ProjectResource} rather than either concrete file type.
 *
 * This is deliberately a thin *view* over the existing storage model rather than
 * a second domain: the repositories still store {@link DiagramFile} and
 * {@link NoteFile}, and this module only names the shared shape they project
 * onto. Widening the workspace to further resource kinds later means adding a
 * case here, not rewriting the explorer, the tabs, or search.
 */
import type { DiagramFile, NoteFile } from "./types";

/** The kinds of resource a project can hold today. */
export type ResourceKind = "diagram" | "note";

/**
 * A stored resource, identified by kind and id.
 *
 * Ids are unique across the whole workspace — the in-browser stores prefix them
 * by kind and the folder store derives them from distinct paths — so a resource
 * can be addressed by {@link id} alone. {@link kind} says which store to read it
 * from and how to interpret its content.
 */
export interface ProjectResource {
  /** Which store the resource lives in. */
  kind: ResourceKind;
  /** Stable id of the file within its store. */
  id: string;
  /** The project this resource belongs to. Exactly one. */
  projectId: string;
  /** The file name shown in the explorer. */
  name: string;
}

/** Project the diagram file onto the shared resource shape. */
export function diagramResource(diagram: DiagramFile): ProjectResource {
  return {
    kind: "diagram",
    id: diagram.id,
    projectId: diagram.projectId,
    name: diagram.name,
  };
}

/** Project the markdown note onto the shared resource shape. */
export function noteResource(note: NoteFile): ProjectResource {
  return {
    kind: "note",
    id: note.id,
    projectId: note.projectId,
    name: note.name,
  };
}
