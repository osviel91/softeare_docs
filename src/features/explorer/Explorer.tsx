/**
 * Project explorer (Phase 4; notes added with the documentation layer).
 *
 * Renders the workspace tree: projects, each with its diagrams and markdown
 * notes. Creating, deleting, renaming, and selecting all flow through callbacks
 * so the component stays a pure function of its props; {@link useWorkspace}
 * supplies them. Selection is driven by the parent (it owns the editor buffer),
 * so clicking a row just reports the file.
 *
 * Every diagram and note row offers three affordances: the row itself opens the
 * document, a `✕` asks to delete it (the shell confirms), and a `⋯` opens the
 * context menu (rename, change title, duplicate, delete). Right-clicking the row
 * opens the same menu, and the menu position is reported so the shell can place
 * it. Each project header carries a `＋` that opens the same kind of menu to
 * choose what to add: a diagram or a markdown note.
 */
import { useState, type MouseEvent as ReactMouseEvent } from "react";
import type {
  DiagramFile,
  NoteFile,
  Project,
} from "../../domain/workspace/types";
import { diagramDisplayName } from "../../language/diagram-title";
import { noteDisplayName } from "../../language/markdown/note-title";

/** Viewport coordinates for a context menu. */
export interface MenuPosition {
  x: number;
  y: number;
}

export interface ExplorerProps {
  /** Every project, in storage order. */
  projects: Project[];
  /** Diagram files of the selected project, in display order. */
  diagrams: DiagramFile[];
  /** Markdown notes of the selected project, in display order. */
  notes?: NoteFile[];
  /**
   * Every file in the workspace, across all projects. Used only to filter by
   * name when the search box is non-empty, so the search can match files outside
   * the currently selected project.
   */
  allDiagrams?: DiagramFile[];
  allNotes?: NoteFile[];
  /** The selected project id, or `null` when none is selected. */
  selectedProjectId: string | null;
  /** The loaded diagram id, or `null` when none is loaded. */
  selectedDiagramId: string | null;
  /** The loaded note id, or `null` when none is loaded. */
  selectedNoteId?: string | null;
  /** True while the initial load or any action is in flight. */
  isLoading: boolean;
  /** Called with a proposed project name when the user creates one. */
  onCreateProject: (name: string) => void;
  /** Called with a project id when the user deletes it. */
  onDeleteProject: (id: string) => void;
  /**
   * Called when the user asks to add a file to a project. The shell opens a menu
   * offering a new diagram or a new markdown note, anchored at the position.
   */
  onAddMenu?: (project: Project, position: MenuPosition) => void;
  /**
   * Called when the user asks to delete a diagram. The shell opens a
   * confirmation dialog before anything is removed. Optional so the explorer
   * stays usable as a pure list in tests.
   */
  onDeleteDiagram?: (diagram: DiagramFile) => void;
  /** Called when the user asks to delete a note (confirmed by the shell). */
  onDeleteNote?: (note: NoteFile) => void;
  /** Called when the user selects a diagram to load it into the editor. */
  onLoadDiagram: (diagram: DiagramFile) => void;
  /** Called when the user selects a note to load it into the editor. */
  onLoadNote?: (note: NoteFile) => void;
  /** Open the actions menu for a diagram at the reported position. */
  onDiagramMenu?: (diagram: DiagramFile, position: MenuPosition) => void;
  /** Open the actions menu for a note at the reported position. */
  onNoteMenu?: (note: NoteFile, position: MenuPosition) => void;
  /** Open the actions menu for a project at the reported position. */
  onProjectMenu?: (project: Project, position: MenuPosition) => void;
  /**
   * How many paths the user has removed from the app but left on disk. When
   * greater than zero the header offers to restore them, so a "remove from app"
   * is never a dead end.
   */
  hiddenCount?: number;
  /** Reveal every path that was removed from the app. */
  onUnhideAll?: () => void;
  /**
   * Called when the user clicks "Open folder…". Opens a local folder via the
   * File System Access API (Phase 5). Absent when the feature is hidden.
   */
  onOpenFolder?: () => void;
  /** The opened folder's name, or `null` for in-browser projects. */
  folderName?: string | null;
  /** Whether the browser supports the File System Access API. */
  folderSupported?: boolean;
}

const EMPTY_HINT =
  "No projects yet. Create one to start saving diagrams and notes.";

/** The viewport position just below a button, for anchoring a menu. */
function positionBelow(element: HTMLElement): MenuPosition {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

export default function Explorer({
  projects,
  diagrams,
  notes = [],
  allDiagrams = [],
  allNotes = [],
  selectedProjectId,
  selectedDiagramId,
  selectedNoteId = null,
  isLoading,
  onCreateProject,
  onDeleteProject,
  onAddMenu,
  onDeleteDiagram,
  onDeleteNote,
  onLoadDiagram,
  onLoadNote,
  onDiagramMenu,
  onNoteMenu,
  onProjectMenu,
  hiddenCount = 0,
  onUnhideAll,
  onOpenFolder,
  folderName = null,
  folderSupported = false,
}: ExplorerProps) {
  const [pendingName, setPendingName] = useState<string>("");
  // The search filters files by name across all projects. It is local UI state:
  // clearing it restores the normal selected-project view.
  const [search, setSearch] = useState<string>("");

  const create = (): void => {
    const name = pendingName.trim();
    if (name) {
      onCreateProject(name);
      setPendingName("");
    }
  };

  // With a non-empty query, match names across every project; otherwise keep the
  // normal view of the selected project's files. Matching is a case-insensitive
  // substring test on the trimmed query. A diagram's name is the `title` in its
  // source and a note's is its first heading, so renaming either renames it here;
  // the backing file name is matched too, so a search by file name works.
  const query = search.trim().toLowerCase();
  const diagramName = (diagram: DiagramFile): string =>
    diagramDisplayName(diagram.name, diagram.source);
  const noteName = (note: NoteFile): string =>
    noteDisplayName(note.name, note.markdown);
  const matchesDiagram = (diagram: DiagramFile): boolean =>
    query === "" ||
    `${diagramName(diagram)} ${diagram.name}`.toLowerCase().includes(query);
  const matchesNote = (note: NoteFile): boolean =>
    query === "" ||
    `${noteName(note)} ${note.name}`.toLowerCase().includes(query);
  const displayDiagrams =
    query === "" ? diagrams : allDiagrams.filter(matchesDiagram);
  const displayNotes = query === "" ? notes : allNotes.filter(matchesNote);
  const noMatches = displayDiagrams.length === 0 && displayNotes.length === 0;

  const modeLabel = folderName ? `“${folderName}”` : "In-browser projects";

  return (
    <nav className="explorer" data-testid="explorer">
      <div
        className="explorer__header"
        data-testid="explorer-header"
        role="region"
        aria-label="Workspace source"
      >
        <span className="explorer__mode" data-testid="explorer-mode">
          {modeLabel}
        </span>
        {onOpenFolder && (
          <button
            type="button"
            className="explorer__open-button"
            data-testid="open-folder-button"
            aria-label={folderName ? "Close folder" : "Open a local folder"}
            disabled={!folderSupported}
            onClick={onOpenFolder}
          >
            {folderName ? "Close folder" : "Open folder…"}
          </button>
        )}
      </div>

      {hiddenCount > 0 && onUnhideAll && (
        <div className="explorer__hidden" data-testid="explorer-hidden">
          <span className="explorer__hidden-label">
            {hiddenCount} removed from app
          </span>
          <button
            type="button"
            className="explorer__hidden-button"
            data-testid="unhide-all-button"
            onClick={onUnhideAll}
          >
            Restore
          </button>
        </div>
      )}

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

      <div className="explorer__search" data-testid="explorer-search">
        <label className="visually-hidden" htmlFor="diagram-search-input">
          Search diagrams and notes
        </label>
        <input
          id="diagram-search-input"
          className="explorer__search-input"
          data-testid="diagram-search-input"
          type="search"
          placeholder="Search diagrams and notes…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {isLoading ? (
        <p className="explorer__loading" data-testid="explorer-loading">
          Loading projects…
        </p>
      ) : query !== "" && noMatches ? (
        <p className="explorer__empty" data-testid="explorer-empty">
          No diagrams or notes match “{search.trim()}”.
        </p>
      ) : projects.length === 0 ? (
        <p className="explorer__empty" data-testid="explorer-empty">
          {EMPTY_HINT}
        </p>
      ) : (
        <ul className="explorer__projects" data-testid="explorer-projects">
          {projects.map((project) => {
            const projectDiagrams = displayDiagrams.filter(
              (diagram) => diagram.projectId === project.id,
            );
            const projectNotes = displayNotes.filter(
              (note) => note.projectId === project.id,
            );
            return (
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
                <div
                  className="explorer__project-header"
                  onContextMenu={(event) => {
                    if (!onProjectMenu) return;
                    event.preventDefault();
                    onProjectMenu(project, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <span
                    className="explorer__project-name"
                    data-testid="project-name"
                  >
                    {project.name}
                  </span>
                  {onAddMenu && (
                    <button
                      type="button"
                      className="explorer__project-add"
                      data-testid="project-add-button"
                      aria-label={`Add diagram or note to ${project.name}`}
                      aria-haspopup="menu"
                      title="Add diagram or note"
                      onClick={(event) =>
                        onAddMenu(project, positionBelow(event.currentTarget))
                      }
                    >
                      ＋
                    </button>
                  )}
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
                  {projectDiagrams.length === 0 &&
                  query === "" &&
                  selectedProjectId === project.id ? (
                    <li
                      className="explorer__diagram-empty"
                      data-testid="explorer-diagram-empty"
                    >
                      No diagrams.
                    </li>
                  ) : (
                    projectDiagrams.map((diagram) => (
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
                        onContextMenu={(
                          event: ReactMouseEvent<HTMLLIElement>,
                        ) => {
                          if (!onDiagramMenu) return;
                          event.preventDefault();
                          onDiagramMenu(diagram, {
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                      >
                        <button
                          type="button"
                          className="explorer__diagram-button"
                          data-testid="select-diagram-button"
                          aria-label={`Load diagram ${diagramName(diagram)}`}
                          onClick={() => onLoadDiagram(diagram)}
                        >
                          <span
                            className="explorer__item-icon"
                            aria-hidden="true"
                          >
                            ▦
                          </span>
                          {diagramName(diagram)}
                        </button>
                        {onDeleteDiagram && (
                          <button
                            type="button"
                            className="explorer__diagram-delete"
                            data-testid="delete-diagram-button"
                            aria-label={`Delete diagram ${diagramName(diagram)}`}
                            title="Delete diagram…"
                            onClick={() => onDeleteDiagram(diagram)}
                          >
                            ✕
                          </button>
                        )}
                        {onDiagramMenu && (
                          <button
                            type="button"
                            className="explorer__diagram-menu"
                            data-testid="diagram-menu-button"
                            aria-label={`Actions for diagram ${diagramName(diagram)}`}
                            title="More actions…"
                            onClick={(event) =>
                              onDiagramMenu(
                                diagram,
                                positionBelow(event.currentTarget),
                              )
                            }
                          >
                            ⋯
                          </button>
                        )}
                      </li>
                    ))
                  )}
                </ul>

                <ul className="explorer__notes" data-testid="explorer-notes">
                  {projectNotes.length === 0 &&
                  query === "" &&
                  selectedProjectId === project.id ? (
                    <li
                      className="explorer__diagram-empty"
                      data-testid="explorer-note-empty"
                    >
                      No notes.
                    </li>
                  ) : (
                    projectNotes.map((note) => (
                      <li
                        key={note.id}
                        className={`explorer__note${
                          note.id === selectedNoteId
                            ? " explorer__note--selected"
                            : ""
                        }`}
                        data-testid="explorer-note"
                        aria-current={
                          note.id === selectedNoteId ? "true" : undefined
                        }
                        onContextMenu={(
                          event: ReactMouseEvent<HTMLLIElement>,
                        ) => {
                          if (!onNoteMenu) return;
                          event.preventDefault();
                          onNoteMenu(note, {
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                      >
                        <button
                          type="button"
                          className="explorer__note-button"
                          data-testid="select-note-button"
                          aria-label={`Open note ${noteName(note)}`}
                          onClick={() => onLoadNote?.(note)}
                        >
                          <span
                            className="explorer__item-icon"
                            aria-hidden="true"
                          >
                            ¶
                          </span>
                          {noteName(note)}
                        </button>
                        {onDeleteNote && (
                          <button
                            type="button"
                            className="explorer__note-delete"
                            data-testid="delete-note-button"
                            aria-label={`Delete note ${noteName(note)}`}
                            title="Delete note…"
                            onClick={() => onDeleteNote(note)}
                          >
                            ✕
                          </button>
                        )}
                        {onNoteMenu && (
                          <button
                            type="button"
                            className="explorer__note-menu"
                            data-testid="note-menu-button"
                            aria-label={`Actions for note ${noteName(note)}`}
                            title="More actions…"
                            onClick={(event) =>
                              onNoteMenu(
                                note,
                                positionBelow(event.currentTarget),
                              )
                            }
                          >
                            ⋯
                          </button>
                        )}
                      </li>
                    ))
                  )}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
