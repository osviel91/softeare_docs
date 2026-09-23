/**
 * JSON (de)serialization for a {@link WorkspaceSnapshot}.
 *
 * Export writes the whole workspace — projects, diagrams, and markdown notes —
 * to a single JSON document so it can be downloaded and shared. Import validates
 * the document's shape before trusting it, returning a {@link Result} so
 * malformed input never throws mid-parse.
 *
 * `notes` is optional on import so a document exported before notes existed still
 * loads; export always writes the array.
 */
import type {
  DiagramFile,
  NoteFile,
  Project,
  WorkspaceSnapshot,
} from "../domain/workspace/types";
import { err, ok, type Result } from "../shared/result/result";

/** The shape a {@link WorkspaceSnapshot} takes once serialized to JSON. */
interface SerializedWorkspace {
  projects: Project[];
  diagrams: DiagramFile[];
  notes: NoteFile[];
}

/** Produce a stable, human-readable JSON string for the given snapshot. */
export function exportWorkspaceToJSON(snapshot: WorkspaceSnapshot): string {
  const payload: SerializedWorkspace = {
    projects: snapshot.projects.map((project) => ({
      ...project,
      datasetIds: [...project.datasetIds],
      noteIds: [...(project.noteIds ?? [])],
    })),
    diagrams: snapshot.diagrams.map((diagram) => ({ ...diagram })),
    notes: (snapshot.notes ?? []).map((note) => ({ ...note })),
  };
  return JSON.stringify(payload, null, 2);
}

/** Validate a single project object, returning an error message when invalid. */
function validateProject(value: unknown): string | null {
  if (typeof value !== "object" || value === null)
    return "projects must be an array of objects";
  const project = value as Record<string, unknown>;
  if (typeof project.id !== "string") return "project is missing a string id";
  if (typeof project.name !== "string")
    return `project "${String(project.id)}" is missing a string name`;
  if (
    !Array.isArray(project.datasetIds) ||
    !project.datasetIds.every((id) => typeof id === "string")
  ) {
    return `project "${String(project.id)}" has a non-string datasetIds array`;
  }
  if (
    project.noteIds !== undefined &&
    (!Array.isArray(project.noteIds) ||
      !project.noteIds.every((id) => typeof id === "string"))
  ) {
    return `project "${String(project.id)}" has a non-string noteIds array`;
  }
  return null;
}

/** Validate a single diagram object, returning an error message when invalid. */
function validateDiagram(value: unknown): string | null {
  if (typeof value !== "object" || value === null)
    return "diagrams must be an array of objects";
  const diagram = value as Record<string, unknown>;
  if (typeof diagram.id !== "string") return "diagram is missing a string id";
  if (typeof diagram.name !== "string")
    return `diagram "${String(diagram.id)}" is missing a string name`;
  if (typeof diagram.source !== "string")
    return `diagram "${String(diagram.id)}" is missing a string source`;
  if (typeof diagram.projectId !== "string") {
    return `diagram "${String(diagram.id)}" is missing a string projectId`;
  }
  return null;
}

/** Validate a single note object, returning an error message when invalid. */
function validateNote(value: unknown): string | null {
  if (typeof value !== "object" || value === null)
    return "notes must be an array of objects";
  const note = value as Record<string, unknown>;
  if (typeof note.id !== "string") return "note is missing a string id";
  if (typeof note.name !== "string")
    return `note "${String(note.id)}" is missing a string name`;
  if (typeof note.markdown !== "string")
    return `note "${String(note.id)}" is missing a string markdown body`;
  if (typeof note.projectId !== "string") {
    return `note "${String(note.id)}" is missing a string projectId`;
  }
  return null;
}

/**
 * Parse and validate a workspace JSON document.
 *
 * Returns the reconstructed {@link WorkspaceSnapshot} on success, or a
 * descriptive error describing the first problem found.
 */
export function importWorkspaceFromJSON(
  json: string,
): Result<WorkspaceSnapshot, Error> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return err(
      new Error(
        `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    return err(new Error("Workspace document must be a JSON object"));
  }

  const { projects, diagrams } = parsed as Record<string, unknown>;
  // A document written before notes existed has no `notes` key at all.
  const notes = (parsed as Record<string, unknown>).notes ?? [];

  if (!Array.isArray(projects)) {
    return err(new Error("Workspace is missing a 'projects' array"));
  }
  if (!Array.isArray(diagrams)) {
    return err(new Error("Workspace is missing a 'diagrams' array"));
  }
  if (!Array.isArray(notes)) {
    return err(new Error("Workspace 'notes' must be an array"));
  }

  for (const [index, project] of projects.entries()) {
    const problem = validateProject(project);
    if (problem) return err(new Error(`projects[${index}]: ${problem}`));
  }

  for (const [index, diagram] of diagrams.entries()) {
    const problem = validateDiagram(diagram);
    if (problem) return err(new Error(`diagrams[${index}]: ${problem}`));
  }

  for (const [index, note] of notes.entries()) {
    const problem = validateNote(note);
    if (problem) return err(new Error(`notes[${index}]: ${problem}`));
  }

  return ok({
    projects: (projects as Project[]).map((project) => ({
      ...project,
      datasetIds: [...(project.datasetIds ?? [])],
      noteIds: [...(project.noteIds ?? [])],
    })),
    diagrams: (diagrams as DiagramFile[]).map((diagram) => ({ ...diagram })),
    notes: (notes as NoteFile[]).map((note) => ({ ...note })),
  });
}
