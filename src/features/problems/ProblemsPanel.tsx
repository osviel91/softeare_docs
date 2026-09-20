/**
 * Problems panel: the project's diagnostics, grouped by severity.
 *
 * The panel is presentational: it takes the diagnostics the project index
 * already computed and reports the one the user chose through `onOpen`. It does
 * no filtering, deduplication, or resolution — those belong to the index and the
 * validator — so the panel can be tested against any diagnostic list and stays
 * useful for any resource kind.
 *
 * Severity order is fixed (errors, then warnings, then info) rather than derived
 * from the input order, because a list that reshuffles as files are edited would
 * be read as movement rather than as the same problems. The three headings are
 * always present, with their counts, so an empty Errors group reads as "none",
 * not as a missing section.
 */
import type {
  ProjectDiagnostic,
  ProjectDiagnosticSeverity,
} from "../../domain/project/project-index";

export interface ProblemsPanelProps {
  diagnostics: ProjectDiagnostic[];
  /** Called when a problem is chosen — the shell opens the resource at the range. */
  onOpen: (diagnostic: ProjectDiagnostic) => void;
  /** Human-readable name for a resource id, for the row's location line. */
  labelFor?: (resourceId: string) => string;
}

/** The severity groups, most severe first, with the heading each one shows. */
const GROUPS: ReadonlyArray<{
  severity: ProjectDiagnosticSeverity;
  heading: string;
}> = [
  { severity: "error", heading: "Errors" },
  { severity: "warning", heading: "Warnings" },
  { severity: "info", heading: "Info" },
];

/**
 * The `name:line` a row shows.
 *
 * The AST stores 0-based lines and every human-readable surface is 1-based, so
 * the conversion happens here, once, next to the only place it is displayed. A
 * diagnostic with no range has no line to name and shows the resource alone.
 */
function locationOf(
  diagnostic: ProjectDiagnostic,
  labelFor: ProblemsPanelProps["labelFor"],
): string {
  const name = labelFor
    ? labelFor(diagnostic.resourceId)
    : diagnostic.resourceId;
  const range = diagnostic.sourceRange;
  return range ? `${name}:${range.start.line + 1}` : name;
}

/** The problems list: one section per severity, one clickable row per problem. */
export default function ProblemsPanel({
  diagnostics,
  onOpen,
  labelFor,
}: ProblemsPanelProps) {
  if (diagnostics.length === 0) {
    return (
      <div className="problems" data-testid="problems">
        <p className="problems__empty" data-testid="problems-empty">
          No problems found.
        </p>
      </div>
    );
  }

  return (
    <div className="problems" data-testid="problems">
      {GROUPS.map((group) => {
        const items = diagnostics.filter(
          (diagnostic) => diagnostic.severity === group.severity,
        );
        return (
          <section
            key={group.severity}
            className={`problems__group problems__group--${group.severity}`}
            data-testid="problems-group"
            data-severity={group.severity}
            aria-label={group.heading}
          >
            <h3 className="problems__heading">
              {`${group.heading} (${items.length})`}
            </h3>
            {items.length > 0 ? (
              <ul className="problems__list">
                {items.map((diagnostic, index) => (
                  <li
                    key={`${diagnostic.resourceId}:${
                      diagnostic.sourceRange?.start.line ?? "?"
                    }:${index}`}
                  >
                    <button
                      type="button"
                      className={`problems__item problems__item--${diagnostic.severity}`}
                      data-testid="problem-item"
                      data-severity={diagnostic.severity}
                      onClick={() => onOpen(diagnostic)}
                    >
                      <span className="problems__message">
                        {diagnostic.message}
                      </span>
                      <span className="problems__where">
                        {locationOf(diagnostic, labelFor)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
