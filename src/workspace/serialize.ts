/**
 * JSON (de)serialization for a {@link WorkspaceSnapshot} (Phase 4).
 *
 * Export writes the whole workspace to a single JSON document so it can be
 * downloaded and shared. Import validates the document's shape before trusting
 * it, returning a {@link Result} so malformed input never throws mid-parse.
 *
 * The round-trip is lossless for well-formed snapshots: `export` then `import`
 * reproduces the same {@link WorkspaceSnapshot}.
 */
import type {
  DiagramFile,
  Project,
  WorkspaceSnapshot,
} from "../domain/workspace/types";
import { err, ok, type Result } from "../shared/result/result";

/** The shape a {@link WorkspaceSnapshot} takes once serialized to JSON. */
interface SerializedWorkspace {
  projects: Project[];
  diagrams: DiagramFile[];
}

/** Produce a stable, human-readable JSON string for the given snapshot. */
export function exportWorkspaceToJSON(snapshot: WorkspaceSnapshot): string {
  const payload: SerializedWorkspace = {
    projects: snapshot.projects.map((project) => ({ ...project })),
    diagrams: snapshot.diagrams.map((diagram) => ({ ...diagram })),
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

  if (!Array.isArray(projects)) {
    return err(new Error("Workspace is missing a 'projects' array"));
  }
  if (!Array.isArray(diagrams)) {
    return err(new Error("Workspace is missing a 'diagrams' array"));
  }

  for (const [index, project] of projects.entries()) {
    const problem = validateProject(project);
    if (problem) return err(new Error(`projects[${index}]: ${problem}`));
  }

  for (const [index, diagram] of diagrams.entries()) {
    const problem = validateDiagram(diagram);
    if (problem) return err(new Error(`diagrams[${index}]: ${problem}`));
  }

  return ok({
    projects: (projects as Project[]).map((project) => ({
      ...project,
      datasetIds: [...project.datasetIds],
    })),
    diagrams: (diagrams as DiagramFile[]).map((diagram) => ({ ...diagram })),
  });
}
