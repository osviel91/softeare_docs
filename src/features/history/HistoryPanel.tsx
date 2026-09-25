/**
 * History panel ("Trajectory").
 *
 * The project's version history drawn as a tree: one branch per diagram, each
 * carrying that diagram's timeline newest first. A version therefore always sits
 * under the document it belongs to, which is the reference a flat, single
 * timeline could not give — and it answers "where is this project's history?"
 * without having to open each file in turn.
 *
 * The panel stays presentational: the hook owns recording and the shell owns the
 * editor source, so the panel can be tested against a plain version list. Rows
 * show when a version was captured, why (its label), and a one-line summary; the
 * version matching the editor's buffer in the open diagram is marked "Current".
 *
 * The flat `versions` list is grouped here rather than passed pre-grouped, so a
 * caller that only has one timeline (or a test with a single diagram) keeps
 * working unchanged.
 */
import { useMemo } from "react";
import type { DiagramVersion } from "../../domain/workspace/version";
import {
  formatVersionTime,
  sameVersionContent,
  versionSummary,
} from "../../domain/workspace/version";
import PageHeader from "../ui/PageHeader";

export interface HistoryPanelProps {
  /** The project's versions across every diagram, newest first. */
  versions: DiagramVersion[];
  /** True while a timeline load is in flight. */
  isLoading: boolean;
  /** Whether a diagram is loaded; disables capture when false. */
  hasDiagram: boolean;
  /** The editor's current buffer, used to mark the current version. */
  currentSource: string;
  /** Capture the current buffer as a labeled checkpoint. */
  onSaveVersion: () => void;
  /** Load a version's source into the editor. */
  onRestore: (version: DiagramVersion) => void;
  /** Forget a version. */
  onDeleteVersion: (versionId: string) => void;
  /** The diagram shown in the editor, whose branch is marked as open. */
  activeDiagramId?: string | null;
  /** Human-readable name for a version's diagram, for the branch header. */
  labelForDiagram?: (diagramId: string) => string;
  /** Short kind label ("Diagram", "Event flow") for a branch header. */
  kindForDiagram?: (diagramId: string) => string;
  /** The project whose history this is, shown in the header when known. */
  projectName?: string | null;
  /** When entered from a resource, hide the other project branches. */
  resourceScoped?: boolean;
  onShowProjectHistory?: () => void;
  onShowResourceHistory?: () => void;
}

/** One diagram's branch: its id and every version recorded for it. */
interface Branch {
  diagramId: string;
  versions: DiagramVersion[];
}

/**
 * Group a newest-first version list into one branch per diagram.
 *
 * First appearance decides branch order, so the most recently edited diagram
 * leads — which is what a reader scanning "what changed lately?" expects.
 */
function branchesOf(versions: DiagramVersion[]): Branch[] {
  const byDiagram = new Map<string, Branch>();
  for (const version of versions) {
    let branch = byDiagram.get(version.diagramId);
    if (!branch) {
      branch = { diagramId: version.diagramId, versions: [] };
      byDiagram.set(version.diagramId, branch);
    }
    branch.versions.push(version);
  }
  return [...byDiagram.values()];
}

/** The glyph a branch header shows for its document kind. */
function kindIcon(kind: string | undefined): string {
  if (kind === "note" || kind === "markdown-document") return "¶";
  if (kind === "event-flow") return "⚡";
  return "▦";
}

/** The history tree: one branch per diagram, one row per captured version. */
export default function HistoryPanel({
  versions,
  isLoading,
  hasDiagram,
  currentSource,
  onSaveVersion,
  onRestore,
  onDeleteVersion,
  activeDiagramId = null,
  labelForDiagram,
  kindForDiagram,
  projectName = null,
  resourceScoped = false,
  onShowProjectHistory,
  onShowResourceHistory,
}: HistoryPanelProps) {
  const branches = useMemo(() => branchesOf(versions), [versions]);

  /**
   * Whether a version is the one on screen. When the caller does not say which
   * diagram is open, the content match stands alone, which keeps the panel
   * usable against a single timeline.
   */
  const isCurrent = (version: DiagramVersion): boolean =>
    sameVersionContent(version.source, currentSource) &&
    (activeDiagramId === null || version.diagramId === activeDiagramId);

  return (
    <section className="history" data-testid="history-panel">
      <PageHeader
        title={resourceScoped ? "Resource history" : "Project history"}
        description={
          <>
            {projectName && (
              <span className="history__project" data-testid="history-project">
                {projectName} ·{" "}
              </span>
            )}
            <span className="history__count" data-testid="history-count">
              {versions.length} version{versions.length === 1 ? "" : "s"}
              {branches.length > 1 ? ` · ${branches.length} diagrams` : ""}
            </span>
          </>
        }
        actions={
          <>
            <button
              type="button"
              className="button button--primary"
              data-testid="save-version-button"
              disabled={!hasDiagram}
              onClick={onSaveVersion}
            >
              Create checkpoint
            </button>
            {resourceScoped && onShowProjectHistory && (
              <button
                type="button"
                className="scope-navigation"
                data-testid="project-history-navigation"
                onClick={onShowProjectHistory}
              >
                Project history
              </button>
            )}
            {!resourceScoped && onShowResourceHistory && activeDiagramId && (
              <button
                type="button"
                className="scope-navigation"
                data-testid="resource-history-navigation"
                onClick={onShowResourceHistory}
              >
                Resource history
              </button>
            )}
          </>
        }
      />

      {!hasDiagram ? (
        <p className="history__empty" data-testid="history-empty">
          Open a diagram to record its versions.
        </p>
      ) : isLoading && versions.length === 0 ? (
        <p className="history__empty" data-testid="history-loading">
          Loading versions…
        </p>
      ) : versions.length === 0 ? (
        <p className="history__empty" data-testid="history-empty">
          No versions yet. They are recorded automatically as you edit.
        </p>
      ) : (
        <ol className="history__tree" data-testid="history-tree">
          {branches.map((branch) => {
            const isActive = branch.diagramId === activeDiagramId;
            const kind = kindForDiagram?.(branch.diagramId);
            return (
              <li
                key={branch.diagramId}
                className={`history__branch${
                  isActive ? " history__branch--active" : ""
                }`}
                data-testid="history-branch"
                data-diagram-id={branch.diagramId}
              >
                <div className="history__branch-header">
                  <span className="history__branch-icon" aria-hidden="true">
                    {kindIcon(kind)}
                  </span>
                  <span
                    className="history__branch-name"
                    data-testid="history-branch-name"
                  >
                    {labelForDiagram?.(branch.diagramId) ?? branch.diagramId}
                  </span>
                  {isActive && (
                    <span
                      className="history__badge"
                      data-testid="history-branch-open"
                    >
                      Open
                    </span>
                  )}
                  <span className="history__branch-count">
                    {branch.versions.length}
                  </span>
                </div>
                <ol className="history__list" data-testid="history-list">
                  {branch.versions.map((version) => {
                    const current = isCurrent(version);
                    return (
                      <li
                        key={version.id}
                        className={`history__version${
                          current ? " history__version--current" : ""
                        }`}
                        data-testid="history-version"
                        data-diagram-id={version.diagramId}
                      >
                        <div className="history__version-header">
                          <time
                            className="history__time"
                            dateTime={new Date(version.createdAt).toISOString()}
                          >
                            {formatVersionTime(version.createdAt)}
                          </time>
                          <span
                            className="history__label"
                            data-testid="version-label"
                          >
                            {version.label}
                          </span>
                          {current && (
                            <span
                              className="history__badge"
                              data-testid="version-current"
                            >
                              Current
                            </span>
                          )}
                        </div>
                        <p
                          className="history__summary"
                          data-testid="version-summary"
                          title={version.source}
                        >
                          {versionSummary(version.source)}
                        </p>
                        <div className="history__actions">
                          <button
                            type="button"
                            className="button button--ghost button--small"
                            data-testid="restore-version-button"
                            aria-label={`Restore version from ${formatVersionTime(version.createdAt)}`}
                            disabled={current}
                            onClick={() => onRestore(version)}
                          >
                            Restore
                          </button>
                          <button
                            type="button"
                            className="button button--ghost button--small button--danger-text"
                            data-testid="delete-version-button"
                            aria-label={`Delete version from ${formatVersionTime(version.createdAt)}`}
                            onClick={() => onDeleteVersion(version.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
