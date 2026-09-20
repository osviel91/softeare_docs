/**
 * History panel ("Trajectory").
 *
 * Lists a diagram's captured versions, newest first, and lets the user restore
 * or forget one. It is a pure function of its props — the hook owns recording
 * and the shell owns the editor source — so the panel can be tested against a
 * plain version list.
 *
 * Each row shows when the version was captured, why (its label), and a one-line
 * summary of its source. The version whose source matches the editor's current
 * buffer is marked "Current" and its restore button disabled, so the list also
 * answers "where am I on the timeline?".
 */
import type { DiagramVersion } from "../../domain/workspace/version";
import {
  formatVersionTime,
  sameVersionContent,
  versionSummary,
} from "../../domain/workspace/version";

export interface HistoryPanelProps {
  /** The timeline to render, newest first. */
  versions: DiagramVersion[];
  /** True while the timeline is loading. */
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
}

export default function HistoryPanel({
  versions,
  isLoading,
  hasDiagram,
  currentSource,
  onSaveVersion,
  onRestore,
  onDeleteVersion,
}: HistoryPanelProps) {
  return (
    <section className="history" data-testid="history-panel">
      <header className="history__header">
        <div className="history__heading">
          <h2 className="history__title">Trajectory</h2>
          <span className="history__count" data-testid="history-count">
            {versions.length} version{versions.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          type="button"
          className="button button--primary"
          data-testid="save-version-button"
          disabled={!hasDiagram}
          onClick={onSaveVersion}
        >
          Save version
        </button>
      </header>

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
        <ol className="history__list" data-testid="history-list">
          {versions.map((version) => {
            const isCurrent = sameVersionContent(version.source, currentSource);
            return (
              <li
                key={version.id}
                className={`history__version${
                  isCurrent ? " history__version--current" : ""
                }`}
                data-testid="history-version"
              >
                <div className="history__version-header">
                  <time
                    className="history__time"
                    dateTime={new Date(version.createdAt).toISOString()}
                  >
                    {formatVersionTime(version.createdAt)}
                  </time>
                  <span className="history__label" data-testid="version-label">
                    {version.label}
                  </span>
                  {isCurrent && (
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
                    disabled={isCurrent}
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
      )}
    </section>
  );
}
