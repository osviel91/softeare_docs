/**
 * Project overview.
 *
 * A dashboard over the {@link ProjectIndex} — and *only* over it. Every number
 * here is a count of something the index already derived, so the overview can
 * never disagree with the Problems panel, the outline or find-references. Nothing
 * in this component reads a file, parses text, or recomputes a project fact.
 *
 * It is a pure function of the index, which is what lets it be tested against a
 * hand-built project and, later, served to an agent as the same summary.
 */
import type { ProjectIndex } from "../../domain/project/project-index";

export interface ProjectOverviewProps {
  /** The active project's index, or `null` while none is loaded. */
  index: ProjectIndex | null;
  /** Opens a resource when its row is clicked. */
  onOpenResource?: (resourceId: string) => void;
}

/** Count diagnostics by severity in one pass. */
function severityCounts(index: ProjectIndex): {
  errors: number;
  warnings: number;
  info: number;
} {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const diagnostic of index.diagnostics) {
    if (diagnostic.severity === "error") errors += 1;
    else if (diagnostic.severity === "warning") warnings += 1;
    else info += 1;
  }
  return { errors, warnings, info };
}

/** The one-line summary of an entity count, pluralised. */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export default function ProjectOverview({
  index,
  onOpenResource,
}: ProjectOverviewProps) {
  if (!index) {
    return (
      <p className="overview__empty" data-testid="overview-empty">
        Open a project to see its overview.
      </p>
    );
  }

  const { errors, warnings, info } = severityCounts(index);
  const broken = index.references.filter(
    (reference) =>
      reference.to === null && reference.problem?.reason !== "external",
  ).length;
  const lifelines = index.participants.filter(
    (symbol) => symbol.kind === "participant" || symbol.kind === "actor",
  );

  return (
    <div className="overview" data-testid="overview">
      <h2 className="overview__title" data-testid="overview-title">
        {index.projectId}
      </h2>

      <div className="overview__cards">
        <section className="overview__card" data-testid="overview-resources">
          <h3>Resources</h3>
          <p>{count(index.diagrams.length, "diagram")}</p>
          <p>{count(index.eventFlows.length, "event flow")}</p>
          <p>{count(index.documents.length, "document")}</p>
        </section>

        {index.eventFlows.length > 0 && (
          <section className="overview__card" data-testid="overview-events">
            <h3>Event architecture</h3>
            <p>
              {count(
                index.eventFlows.reduce(
                  (total, flow) => total + flow.events,
                  0,
                ),
                "event",
              )}
            </p>
            <p>
              {count(
                index.eventFlows.reduce(
                  (total, flow) => total + flow.channels,
                  0,
                ),
                "channel",
              )}
            </p>
          </section>
        )}

        <section className="overview__card" data-testid="overview-symbols">
          <h3>Symbols</h3>
          <p>{count(lifelines.length, "participant")}</p>
          <p>{count(index.references.length, "reference")}</p>
          {broken > 0 && (
            <p className="overview__bad">{count(broken, "broken reference")}</p>
          )}
        </section>

        <section className="overview__card" data-testid="overview-diagnostics">
          <h3>Diagnostics</h3>
          <p className={errors > 0 ? "overview__bad" : undefined}>
            {count(errors, "error")}
          </p>
          <p>{count(warnings, "warning")}</p>
          <p>{count(info, "note")}</p>
        </section>
      </div>

      <h3 className="overview__heading">Everything in this project</h3>
      {index.resources.length === 0 ? (
        <p className="overview__empty" data-testid="overview-no-resources">
          This project has no files yet.
        </p>
      ) : (
        <ul className="overview__resources" data-testid="overview-list">
          {index.resources.map((resource) => (
            <li key={resource.id} data-testid="overview-resource">
              <button
                type="button"
                className="overview__resource"
                data-testid="overview-resource-button"
                onClick={() => onOpenResource?.(resource.id)}
              >
                <span className="overview__resource-icon" aria-hidden="true">
                  {resource.type === "sequence-diagram"
                    ? "▦"
                    : resource.type === "event-flow"
                      ? "⇄"
                      : "¶"}
                </span>
                <span className="overview__resource-title">
                  {resource.title}
                </span>
                <span className="overview__resource-meta">{resource.path}</span>
                <span className="overview__resource-id">{resource.id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
