/**
 * Project explorer (Phase 4).
 *
 * Renders the workspace tree: projects, each with its ordered diagrams. Creating
 * or deleting a project and selecting a diagram all flow through callbacks so the
 * component stays a pure function of its props; {@link useWorkspace} supplies them.
 * Selection is driven by the parent (it owns the editor's source), so clicking a
 * diagram just calls {@link ExplorerProps.onLoadDiagram}.
 */
import { useState } from "react";
import type { DiagramFile, Project } from "../../domain/workspace/types";

export interface ExplorerProps {
  /** Every project, in storage order. */
  projects: Project[];
  /** Diagram files of the selected project, in display order. */
  diagrams: DiagramFile[];
  /** The selected project id, or `null` when none is selected. */
  selectedProjectId: string | null;
  /** The loaded diagram id, or `null` when none is loaded. */
  selectedDiagramId: string | null;
  /** True while the initial load or any action is in flight. */
  isLoading: boolean;
  /** Called with a proposed project name when the user creates one. */
  onCreateProject: (name: string) => void;
  /** Called with a project id when the user deletes it. */
  onDeleteProject: (id: string) => void;
  /** Called when the user selects a diagram to load it into the editor. */
  onLoadDiagram: (diagram: DiagramFile) => void;
}

const EMPTY_HINT = "No projects yet. Create one to start saving diagrams.";

export default function Explorer({
  projects,
  diagrams,
  selectedProjectId,
  selectedDiagramId,
  isLoading,
  onCreateProject,
  onDeleteProject,
  onLoadDiagram,
}: ExplorerProps) {
  const [pendingName, setPendingName] = useState<string>("");

  const create = (): void => {
    const name = pendingName.trim();
    if (name) {
      onCreateProject(name);
      setPendingName("");
    }
  };

  return (
    <nav className="explorer" data-testid="explorer">
      <form
        className="explorer__create"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <label className="visually-hidden" htmlFor="project-name-input">
          New project name
        </label>
        <input
          id="project-name-input"
          className="explorer__input"
          data-testid="project-name-input"
          value={pendingName}
          onChange={(event) => setPendingName(event.target.value)}
          placeholder="New project"
        />
        <button
          type="submit"
          className="explorer__create-button"
          data-testid="create-project-button"
          disabled={pendingName.trim() === ""}
        >
          Add project
        </button>
      </form>

      {isLoading ? (
        <p className="explorer__loading" data-testid="explorer-loading">
          Loading projects…
        </p>
      ) : projects.length === 0 ? (
        <p className="explorer__empty" data-testid="explorer-empty">
          {EMPTY_HINT}
        </p>
      ) : (
        <ul className="explorer__projects" data-testid="explorer-projects">
          {projects.map((project) => (
            <li
              key={project.id}
              className={`explorer__project${
                project.id === selectedProjectId
                  ? " explorer__project--selected"
                  : ""
              }`}
              data-testid="explorer-project"
              aria-current={
                project.id === selectedProjectId ? "true" : undefined
              }
            >
              <div className="explorer__project-header">
                <span
                  className="explorer__project-name"
                  data-testid="project-name"
                >
                  {project.name}
                </span>
                <button
                  type="button"
                  className="explorer__delete-button"
                  data-testid="delete-project-button"
                  aria-label={`Delete project ${project.name}`}
                  onClick={() => onDeleteProject(project.id)}
                >
                  ✕
                </button>
              </div>
              <ul
                className="explorer__diagrams"
                data-testid="explorer-diagrams"
              >
                {diagrams.length === 0 && selectedProjectId === project.id ? (
                  <li
                    className="explorer__diagram-empty"
                    data-testid="explorer-diagram-empty"
                  >
                    No diagrams.
                  </li>
                ) : (
                  diagrams
                    .filter((diagram) => diagram.projectId === project.id)
                    .map((diagram) => (
                      <li
                        key={diagram.id}
                        className={`explorer__diagram${
                          diagram.id === selectedDiagramId
                            ? " explorer__diagram--selected"
                            : ""
                        }`}
                        data-testid="explorer-diagram"
                        aria-current={
                          diagram.id === selectedDiagramId ? "true" : undefined
                        }
                      >
                        <button
                          type="button"
                          className="explorer__diagram-button"
                          data-testid="select-diagram-button"
                          aria-label={`Load diagram ${diagram.name}`}
                          onClick={() => onLoadDiagram(diagram)}
                        >
                          {diagram.name}
                        </button>
                      </li>
                    ))
                )}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
