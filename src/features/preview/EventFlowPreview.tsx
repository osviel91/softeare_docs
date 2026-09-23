/**
 * Event-flow preview.
 *
 * A sibling of {@link ./Preview}, deliberately thinner: an event flow has no
 * notes to expand and no paused-render mode, so this renders the document and
 * hands it to the same {@link DiagramViewport} the sequence preview uses. Sharing
 * the viewport is what gives an event flow pan, zoom, fit and a minimap for free,
 * and it means source↔diagram selection works identically in both languages —
 * the viewport only knows about `data-node-id`, not about what produced it.
 */
import { useMemo } from "react";
import { analyzeEventFlow } from "../../language/eventflow/parser";
import { renderEventFlowDocument } from "../../renderer/pipeline/eventflow-to-svg";
import { projectEventFlowToCatalog } from "../../domain/eventflow/catalog-projection";
import type { EventFlow } from "../../domain/eventflow/ast";
import DiagramViewport from "./DiagramViewport";

type EventFlowView = "flow" | "catalog";

export interface EventFlowPreviewProps {
  /** The event-flow DSL source. */
  source: string;
  /** Called with a node id when the user clicks the element it represents. */
  onNodeSelect?: (nodeId: string) => void;
  /** The node to highlight, following the editor's caret. */
  activeNodeId?: string | null;
  /** Whether the preview is the only visible app pane. */
  maximized?: boolean;
  /** Toggles the preview-only app layout. */
  onToggleMaximize?: () => void;
  flow?: EventFlow | null;
  view?: EventFlowView;
  onViewChange?: (view: EventFlowView) => void;
}

export default function EventFlowPreview({
  source,
  onNodeSelect,
  activeNodeId = null,
  maximized = false,
  onToggleMaximize,
  flow: providedFlow,
  view = "flow",
  onViewChange,
}: EventFlowPreviewProps) {
  const document = useMemo(() => {
    // Parsing here rather than taking an AST keeps this component's contract the
    // same as the sequence preview's: it is handed source, nothing else.
    const { flow } = analyzeEventFlow(source);
    return renderEventFlowDocument(flow);
  }, [source]);
  const flow = providedFlow ?? analyzeEventFlow(source).flow;
  const catalog = useMemo(() => projectEventFlowToCatalog(flow), [flow]);

  const selector = (
    <div
      className="segmented-control event-flow-view-selector"
      role="group"
      aria-label="Event flow view"
    >
      <button
        type="button"
        className={view === "flow" ? "is-active" : ""}
        aria-pressed={view === "flow"}
        onClick={() => onViewChange?.("flow")}
      >
        Flow
      </button>
      <button
        type="button"
        className={view === "catalog" ? "is-active" : ""}
        aria-pressed={view === "catalog"}
        onClick={() => onViewChange?.("catalog")}
      >
        Catalog
      </button>
    </div>
  );

  if (view === "catalog") {
    return (
      <div className="preview" data-testid="event-flow-preview">
        {selector}
        <div className="event-catalog" data-testid="event-catalog">
          {catalog.title && (
            <h2 className="event-catalog__title">{catalog.title}</h2>
          )}
          {catalog.events.length === 0 ? (
            <p className="preview__empty" data-testid="event-catalog-empty">
              Nothing catalogued yet — declare an event or relationship.
            </p>
          ) : (
            <div className="event-catalog__grid">
              {catalog.events.map((event) => (
                <article className="event-catalog__card" key={event.nodeId}>
                  <button
                    type="button"
                    className="event-catalog__event"
                    aria-label={`Reveal event ${event.name}`}
                    onClick={() => onNodeSelect?.(event.nodeId)}
                  >
                    {event.name}
                  </button>
                  {event.metadata.length > 0 && (
                    <dl className="event-catalog__metadata">
                      {event.metadata.map((entry) => (
                        <div key={`${entry.key}-${entry.value}`}>
                          <dt>{entry.key}</dt>
                          <dd>{entry.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {event.publications.length > 0 && (
                    <section>
                      <h3>Published by</h3>
                      {event.publications.map((publication) => (
                        <p key={publication.nodeId}>
                          <button
                            type="button"
                            onClick={() => onNodeSelect?.(publication.nodeId)}
                          >
                            {publication.producer}
                          </button>
                          {publication.channel && (
                            <>
                              {" "}
                              on{" "}
                              <button
                                type="button"
                                onClick={() =>
                                  onNodeSelect?.(publication.channel!.nodeId)
                                }
                              >
                                {publication.channel.name}
                              </button>
                            </>
                          )}
                        </p>
                      ))}
                    </section>
                  )}
                  {event.subscriptions.length > 0 && (
                    <section>
                      <h3>Consumed by</h3>
                      {event.subscriptions.map((subscription) => (
                        <p key={subscription.nodeId}>
                          <button
                            type="button"
                            onClick={() => onNodeSelect?.(subscription.nodeId)}
                          >
                            {subscription.consumer}
                          </button>
                          {subscription.channel && (
                            <>
                              {" "}
                              from{" "}
                              <button
                                type="button"
                                onClick={() =>
                                  onNodeSelect?.(subscription.channel!.nodeId)
                                }
                              >
                                {subscription.channel.name}
                              </button>
                            </>
                          )}
                        </p>
                      ))}
                    </section>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (document.width === 0 || document.height === 0) {
    return (
      <div className="preview" data-testid="event-flow-preview">
        {selector}
        <p className="preview__empty" data-testid="event-flow-empty">
          Nothing to draw yet — declare an event, a producer and a consumer.
        </p>
      </div>
    );
  }

  return (
    <div className="preview" data-testid="event-flow-preview">
      {selector}
      <DiagramViewport
        svg={document.svg}
        size={{ width: document.width, height: document.height }}
        svgTestId="preview-svg"
        resetKey={source}
        onNodeSelect={onNodeSelect}
        activeNodeId={activeNodeId}
        maximized={maximized}
        onToggleMaximize={onToggleMaximize}
      />
    </div>
  );
}
