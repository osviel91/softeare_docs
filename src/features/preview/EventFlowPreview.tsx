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
import { useEffect, useMemo, useState } from "react";
import { analyzeEventFlow } from "../../language/eventflow/parser";
import { renderEventFlowDocument } from "../../renderer/pipeline/eventflow-to-svg";
import { renderEventFlowTopologyDocument } from "../../renderer/pipeline/eventflow-to-topology-svg";
import { renderEventFlowCausalDocument } from "../../renderer/pipeline/eventflow-to-causal-svg";
import { downstreamCausalNeighbors, effectsForHandler, inputsForHandler, outputsForHandler, projectEventFlowToCausalView, upstreamCausalNeighbors, type CausalNodeId, type CausalMessage, type CausalHandler, type CausalEffect, type CausalFailure, type CausalRetry } from "../../domain/eventflow/causal-projection";
import { projectEventFlowToCatalog } from "../../domain/eventflow/catalog-projection";
import { projectEventFlowToTopology } from "../../domain/eventflow/topology-projection";
import {
  CONVENTIONAL_EVENT_METADATA_KEYS,
  type EventFlow,
  type EventMetadataEntry,
} from "../../domain/eventflow/ast";
import DiagramViewport from "./DiagramViewport";
import type { DiagramViewportTransform } from "./DiagramViewport";
import type { SemanticChange } from "../../domain/diff/resource-diff";
import { decorateReviewSvg } from "../proposals/review-decorations";

export type EventFlowView = "flow" | "catalog" | "topology" | "causal";

export interface EventFlowPreviewProps {
  /** The event-flow DSL source. */
  source: string;
  /** Called with a node id when the user clicks the element it represents. */
  onNodeSelect?: (nodeId: string) => void;
  onSemanticMessageSelect?: (messageId: string, nodeId: string | null) => void;
  onSemanticOccurrenceSelect?: (name: string, nodeId: string | null) => void;
  /** The node to highlight, following the editor's caret. */
  activeNodeId?: string | null;
  activeSemanticMessageId?: string | null;
  /** Whether the preview is the only visible app pane. */
  maximized?: boolean;
  /** Toggles the preview-only app layout. */
  onToggleMaximize?: () => void;
  flow?: EventFlow | null;
  view?: EventFlowView;
  onViewChange?: (view: EventFlowView) => void;
  reviewChanges?: SemanticChange[];
  reviewMode?: boolean;
  linkedTransform?: DiagramViewportTransform | null;
  onTransformChange?: (transform: DiagramViewportTransform) => void;
  activeReviewChange?: string | null;
  focusReviewChange?: string | null;
  reviewSide?: "base" | "proposed";
}

export default function EventFlowPreview({
  source,
  onNodeSelect,
  onSemanticMessageSelect,
  onSemanticOccurrenceSelect,
  activeNodeId = null,
  activeSemanticMessageId = null,
  maximized = false,
  onToggleMaximize,
  flow: providedFlow,
  view = "flow",
  onViewChange,
  reviewChanges = [],
  reviewMode = false,
  linkedTransform = null,
  onTransformChange,
  activeReviewChange = null,
  focusReviewChange = null,
  reviewSide = "proposed",
}: EventFlowPreviewProps) {
  const document = useMemo(() => {
    // Parsing here rather than taking an AST keeps this component's contract the
    // same as the sequence preview's: it is handed source, nothing else.
    const { flow } = analyzeEventFlow(source);
    return renderEventFlowDocument(flow);
  }, [source]);
  const reviewSvg = useMemo(
    () => decorateReviewSvg(document.svg, "event-flow", reviewChanges, reviewSide),
    [document.svg, reviewChanges, reviewSide],
  );
  const flow = providedFlow ?? analyzeEventFlow(source).flow;
  const [selectedCausalId, setSelectedCausalId] = useState<CausalNodeId | null>(null);
  useEffect(() => setSelectedCausalId(null), [source]);
  const catalog = useMemo(() => projectEventFlowToCatalog(flow), [flow]);
  const topology = useMemo(() => projectEventFlowToTopology(flow), [flow]);
  const [topologyDetailsOpen, setTopologyDetailsOpen] = useState(false);
  const causal = useMemo(() => projectEventFlowToCausalView(flow), [flow]);
  const causalDocument = useMemo(
    () => renderEventFlowCausalDocument(flow, selectedCausalId),
    [flow, selectedCausalId],
  );
  const topologyDocument = useMemo(
    () => renderEventFlowTopologyDocument(flow),
    [flow],
  );

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
      <button
        type="button"
        className={view === "topology" ? "is-active" : ""}
        aria-pressed={view === "topology"}
        onClick={() => onViewChange?.("topology")}
      >
        Topology
      </button>
      <button
        type="button"
        className={view === "causal" ? "is-active" : ""}
        aria-pressed={view === "causal"}
        onClick={() => onViewChange?.("causal")}
      >
        Causal
      </button>
      {view === "topology" && (
        <button
          type="button"
          className="event-flow-details-toggle"
          aria-pressed={topologyDetailsOpen}
          aria-controls="topology-relationships"
          onClick={() => setTopologyDetailsOpen((open) => !open)}
        >
          {topologyDetailsOpen ? "Hide details" : "Details"}
        </button>
      )}
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
                  {event.description && (
                    <p className="event-catalog__description">
                      {event.description}
                    </p>
                  )}
                  {catalogMetadata(event.metadata).length > 0 && (
                    <dl className="event-catalog__metadata">
                      {catalogMetadata(event.metadata).map((entry) => (
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
          {(catalog.failures?.length || catalog.retries?.length) ? (
            <section className="event-catalog__recovery" aria-label="Failure and retry semantics">
              <h2>Failure and retry semantics</h2>
              {catalog.failures?.map((failure) => <p key={failure.nodeId}><button type="button" onClick={() => onNodeSelect?.(failure.nodeId)}>{failure.id}</button> on {failure.target}{failure.classification ? ` (${failure.classification})` : ""}</p>)}
              {catalog.retries?.map((retry) => <p key={retry.nodeId}><button type="button" onClick={() => onNodeSelect?.(retry.nodeId)}>{retry.id}</button> for {retry.failureId}{retry.mechanism ? ` via ${retry.mechanism}` : " (mechanism unknown)"}{retry.exhaustion ? `; exhaustion: ${retry.exhaustion}` : "; exhaustion unknown"}</p>)}
            </section>
          ) : null}
        </div>
      </div>
    );
  }

  if (view === "topology") {
    return (
      <div className="preview" data-testid="event-flow-preview">
        {selector}
        <div className="event-topology" data-testid="event-topology">
          {topology.services.length === 0 ? (
            <p className="preview__empty" data-testid="event-topology-empty">
              Nothing to map yet — declare a service or relationship.
            </p>
          ) : (
            <>
              <DiagramViewport
                svg={topologyDocument.svg}
                size={{
                  width: topologyDocument.width,
                  height: topologyDocument.height,
                }}
                svgTestId="topology-svg"
                resetKey={source}
                onNodeSelect={onNodeSelect}
                onSemanticMessageSelect={onSemanticMessageSelect}
                onSemanticOccurrenceSelect={onSemanticOccurrenceSelect}
                activeNodeId={activeNodeId}
                activeSemanticMessageId={activeSemanticMessageId}
                maximized={maximized}
                onToggleMaximize={onToggleMaximize}
                reviewMode={reviewMode}
                linkedTransform={linkedTransform}
                onTransformChange={onTransformChange}
                activeReviewChange={activeReviewChange}
                focusReviewChange={focusReviewChange}
              />
              {topologyDetailsOpen && <div
                id="topology-relationships"
                className="event-topology__details"
                aria-label="Topology relationships"
              >
                {topology.connections.map((connection) => (
                  <article
                    key={connection.id}
                    className="event-topology__connection"
                  >
                    <h2>
                      {connection.producer} to {connection.consumer}
                    </h2>
                    <p>
                      {connection.events.length} event
                      {connection.events.length === 1 ? "" : "s"}
                    </p>
                    <ul>
                      {connection.events.map((event) => (
                        <li key={event.name}>
                          <button
                            type="button"
                            onClick={() => {
                              const id =
                                event.publicationNodeIds[0] ??
                                event.subscriptionNodeIds[0];
                              if (id) onNodeSelect?.(id);
                            }}
                          >
                            {event.name}
                          </button>
                          {event.description && (
                            <p className="event-topology__description">
                              {event.description}
                            </p>
                          )}
                          {catalogMetadata(event.metadata).length > 0 && (
                            <dl className="event-catalog__metadata">
                              {catalogMetadata(event.metadata).map((entry) => (
                                <div key={`${entry.key}-${entry.value}`}>
                                  <dt>{entry.key}</dt>
                                  <dd>{entry.value}</dd>
                                </div>
                              ))}
                            </dl>
                          )}
                          {event.channels.length > 0 && (
                            <span>
                              {" "}
                              via{" "}
                              {event.channels
                                .map((channel) => channel.name)
                                .join(", ")}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>}
            </>
          )}
        </div>
      </div>
    );
  }

  if (view === "causal") {
      const selected = causal.messages.find((item) => item.id === selectedCausalId)
      ?? causal.handlers.find((item) => item.id === selectedCausalId)
      ?? causal.effects.find((item) => item.id === selectedCausalId)
      ?? (causal.failures ?? []).find((item) => item.id === selectedCausalId)
      ?? (causal.retries ?? []).find((item) => item.id === selectedCausalId);
    const selectCausal = (id: string) => {
      const causalId = id as CausalNodeId;
      setSelectedCausalId(causalId);
      const item = causal.messages.find((entry) => entry.id === causalId)
        ?? causal.handlers.find((entry) => entry.id === causalId)
        ?? causal.effects.find((entry) => entry.id === causalId)
        ?? (causal.failures ?? []).find((entry) => entry.id === causalId)
        ?? (causal.retries ?? []).find((entry) => entry.id === causalId);
      const sourceId = item?.sourceNodeIds[0];
      if (sourceId) onNodeSelect?.(sourceId);
    };
    return (
      <div className="preview" data-testid="event-flow-preview">
        {selector}
        <div className="event-causal" data-testid="event-causal">
          {causal.messages.length + causal.handlers.length + causal.effects.length + (causal.failures ?? []).length + (causal.retries ?? []).length === 0 ? (
            <p className="preview__empty" data-testid="event-causal-empty">
              Topology is documented, but explicit causal relationships are not. Add Handler-based causal documentation to investigate what handles and causes each event.
            </p>
          ) : (
            <>
              <DiagramViewport
                svg={causalDocument.svg}
                size={{ width: causalDocument.width, height: causalDocument.height }}
                svgTestId="causal-svg"
                resetKey={source}
                onNodeSelect={onNodeSelect}
                onSemanticMessageSelect={onSemanticMessageSelect}
                onSemanticOccurrenceSelect={onSemanticOccurrenceSelect}
                onCausalNodeSelect={selectCausal}
                activeNodeId={activeNodeId}
                activeSemanticMessageId={activeSemanticMessageId}
                maximized={maximized}
                onToggleMaximize={onToggleMaximize}
                reviewMode={reviewMode}
                linkedTransform={linkedTransform}
                onTransformChange={onTransformChange}
                activeReviewChange={activeReviewChange}
                focusReviewChange={focusReviewChange}
              />
              {selected && (
                <CausalDetails item={selected} view={causal} onSourceSelect={onNodeSelect} />
              )}
            </>
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
        svg={reviewSvg}
        size={{ width: document.width, height: document.height }}
        svgTestId="preview-svg"
        resetKey={source}
        onNodeSelect={onNodeSelect}
        onSemanticMessageSelect={onSemanticMessageSelect}
        onSemanticOccurrenceSelect={onSemanticOccurrenceSelect}
        activeNodeId={activeNodeId}
        activeSemanticMessageId={activeSemanticMessageId}
        maximized={maximized}
        onToggleMaximize={onToggleMaximize}
        reviewMode={reviewMode}
        linkedTransform={linkedTransform}
        onTransformChange={onTransformChange}
        activeReviewChange={activeReviewChange}
        focusReviewChange={focusReviewChange}
      />
    </div>
  );
}

type CausalItem = CausalMessage | CausalHandler | CausalEffect | CausalFailure | CausalRetry;
function CausalDetails({ item, view, onSourceSelect }: { item: CausalItem; view: ReturnType<typeof projectEventFlowToCausalView>; onSourceSelect?: (nodeId: string) => void }) {
  const source = item.sourceNodeIds[0];
  const label = String("displayName" in item ? item.displayName : "name" in item ? item.name : "description" in item && item.description ? item.description : "failureId" in item ? item.failureId : "retryId" in item ? item.retryId : item.effectId);
  return (
    <aside className="event-causal__details" aria-label="Causal selection details">
      <strong>{"displayName" in item ? "Handler" : "name" in item ? "Event" : "failureId" in item ? "Failure" : "retryId" in item ? "Retry" : "Effect"}</strong>
      <h2>{label}</h2>
      {"provenance" in item && <p>Provenance: {item.provenance}</p>}
      {"classification" in item && <p>Classification: {item.classification ?? "unknown"}</p>}
      {"mechanism" in item && <p>Retry mechanism: {item.mechanism ?? "unknown"}</p>}
      {"target" in item && <p>Retry target: {item.target ?? "unknown"}</p>}
      {"exhaustion" in item && <p>Exhaustion: {item.exhaustion ?? "not documented"}</p>}
      {"initiation" in item && <p>Initiation: {item.initiation ?? "not documented"}</p>}
      {"service" in item && item.service && <p>Service: {item.service}</p>}
      {"kind" in item && item.kind && <p>Kind: {item.kind}</p>}
      {"details" in item && item.details && (
        <section className="event-causal__authored">
          <h3>Authored documentation</h3>
          <pre>{item.details}</pre>
        </section>
      )}
      {"metadata" in item && item.metadata.length > 0 && (
        <p>Metadata: {item.metadata.map((entry) => `${entry.key}=${entry.value}`).join(", ")}</p>
      )}
      {"displayName" in item && <>
        <p>Inputs: {inputsForHandler(view, item.id).map((entry) => entry.name).join(", ") || "not documented"}</p>
        <p>Outputs: {outputsForHandler(view, item.id).map((entry) => entry.name).join(", ") || "not documented"}</p>
        <p>Effects: {effectsForHandler(view, item.id).map((entry) => entry.description).join(", ") || "not documented"}</p>
      </>}
      {"handlerId" in item && !("displayName" in item) && (
        <p>Owning handler: {item.handlerId.replace(/^handler:/, "")}</p>
      )}
      <p>Upstream: {causalNeighborLabels(view, upstreamCausalNeighbors(view, item.id)).join(", ") || "none documented"}</p>
      <p>Downstream: {causalNeighborLabels(view, downstreamCausalNeighbors(view, item.id)).join(", ") || "none documented"}</p>
      {source && <button type="button" onClick={() => onSourceSelect?.(source)}>Reveal in source</button>}
      <p className="event-causal__focus-note">Selected, immediate, upstream, and downstream entities are highlighted from explicit causal edges only.</p>
    </aside>
  );
}

function causalNeighborLabels(
  view: ReturnType<typeof projectEventFlowToCausalView>,
  ids: CausalNodeId[],
): string[] {
  return ids.map((id) =>
    view.messages.find((entry) => entry.id === id)?.name ??
    view.handlers.find((entry) => entry.id === id)?.displayName ??
    view.effects.find((entry) => entry.id === id)?.description ??
    id,
  );
}

function catalogMetadata(metadata: EventMetadataEntry[]): EventMetadataEntry[] {
  return metadata
    .filter((entry) => entry.key.toLowerCase() !== "description")
    .sort(
      (left, right) =>
        Number(
          !CONVENTIONAL_EVENT_METADATA_KEYS.includes(
            left.key.toLowerCase() as (typeof CONVENTIONAL_EVENT_METADATA_KEYS)[number],
          ),
        ) -
        Number(
          !CONVENTIONAL_EVENT_METADATA_KEYS.includes(
            right.key.toLowerCase() as (typeof CONVENTIONAL_EVENT_METADATA_KEYS)[number],
          ),
        ),
    );
}
