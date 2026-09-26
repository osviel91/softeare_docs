import { useEffect, useMemo, useState } from "react";
import type { DiagramFile } from "../../domain/workspace/types";
import type { ProjectIndex } from "../../domain/project/project-index";
import type { TraceDirection, TraceQueryStart } from "../../domain/project/architecture-trace";
import { analyzeEventFlow } from "../../language/eventflow/parser";
import { resourceRepresentationOfName } from "../../domain/workspace/resource-id";
import { diagramDisplayName } from "../../language/diagram-title";
import Preview from "./Preview";
import EventFlowPreview, { type EventFlowView } from "./EventFlowPreview";
import SemanticMessageInspector from "./SemanticMessageInspector";
import TraceExplorer from "./TraceExplorer";
import { useDiagram } from "./use-diagram";
import { semanticComparison, type ComparisonOccurrence, type ComparisonPane as ComparisonPaneId, type SemanticComparison } from "./semantic-comparison";
import type { ResourceRelationship } from "../../domain/workspace/resource-relationship";

export interface ComparisonViewProps {
  primary: DiagramFile;
  primarySource: string;
  diagrams: DiagramFile[];
  index: ProjectIndex | null;
  resourceIdForFile: (file: DiagramFile) => string | null;
  onExit: () => void;
  onOpenResource: (resourceId: string, nodeId?: string) => void;
  maximizedPane: "a" | "b" | null;
  onMaximize: (pane: "a" | "b") => void;
  onRestore: () => void;
  relationships?: ResourceRelationship[];
}

type Pane = "a" | "b";

interface Session {
  resource: DiagramFile;
  source: string;
  representation: "sequence" | "event-flow";
}

function resourceLabel(file: DiagramFile): string {
  return `${diagramDisplayName(file.name, file.source)} · ${file.name}`;
}

function ComparisonPane({
  pane,
  session,
  index,
  resourceIdForFile,
  maximized,
  onMaximize,
  onRestore,
  onOpenResource,
  comparison,
  counterpartMessageId,
  selectedMessageId,
  onSelectIdentity,
  focusOccurrence,
  onFocusOccurrence,
}: {
  pane: Pane;
  session: Session;
  index: ProjectIndex | null;
  resourceIdForFile: (file: DiagramFile) => string | null;
  maximized: boolean;
  onMaximize: () => void;
  onRestore: () => void;
  onOpenResource: (resourceId: string, nodeId?: string) => void;
  comparison: SemanticComparison;
  counterpartMessageId: string | null;
  selectedMessageId: string | null;
  onSelectIdentity: (messageId: string) => void;
  focusOccurrence: ComparisonOccurrence | null;
  onFocusOccurrence: (occurrence: ComparisonOccurrence) => void;
}) {
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [activeSemanticMessageId, setActiveSemanticMessageId] = useState<string | null>(null);
  const [traceStart, setTraceStart] = useState<TraceQueryStart | null>(null);
  const [traceDirection, setTraceDirection] = useState<TraceDirection>("both");
  const [eventFlowView, setEventFlowView] = useState<EventFlowView>("flow");
  const flow = useMemo(
    () => session.representation === "event-flow" ? analyzeEventFlow(session.source).flow : null,
    [session.representation, session.source],
  );
  const { ast: sequence } = useDiagram(
    session.representation === "sequence" ? session.source : "",
  );
  const resourceId = resourceIdForFile(session.resource);

  useEffect(() => {
    setActiveNodeId(null);
    setActiveSemanticMessageId(null);
    setTraceStart(null);
  }, [session.resource.id, session.source]);

  useEffect(() => {
    if (focusOccurrence?.resourceId !== resourceId) return;
    setActiveNodeId(focusOccurrence.nodeId);
    setActiveSemanticMessageId(focusOccurrence.messageId ?? null);
  }, [focusOccurrence, resourceId]);

  const selectNode = (nodeId: string) => {
    setActiveNodeId(nodeId);
    setActiveSemanticMessageId(null);
  };
  const selectIdentity = (messageId: string, nodeId: string | null) => {
    setActiveSemanticMessageId(messageId);
    onSelectIdentity(messageId);
    if (nodeId) setActiveNodeId(nodeId);
  };
  const selectOccurrence = (name: string, nodeId: string | null) => {
    if (nodeId) setActiveNodeId(nodeId);
    if (resourceId && name) setTraceStart({ resourceId, name });
  };
  const openTrace = (start: TraceQueryStart, direction: TraceDirection) => {
    setTraceStart(start);
    setTraceDirection(direction);
  };

  return (
    <section className={`comparison__pane${maximized ? " comparison__pane--maximized" : ""}`} aria-label={`Viewer ${pane.toUpperCase()}`} data-testid={`comparison-pane-${pane}`}>
      <header className="comparison__header">
        <div>
          <strong>Viewer {pane.toUpperCase()}</strong>
          <h2>{diagramDisplayName(session.resource.name, session.source)}</h2>
          <span>{session.resource.name} · {session.representation === "event-flow" ? "Event Flow" : "Sequence diagram"}</span>
          {session.resource.metadata?.description ? <p>{session.resource.metadata.description}</p> : null}
          {session.resource.metadata?.tags?.length ? <div className="comparison__tags" aria-label="Resource tags">{session.resource.metadata.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
        </div>
        <button type="button" className="icon-button" aria-label={maximized ? `Restore Viewer ${pane.toUpperCase()}` : `Maximize Viewer ${pane.toUpperCase()}`} onClick={maximized ? onRestore : onMaximize}>{maximized ? "⊡" : "⤢"}</button>
      </header>
      <div className="comparison__viewer">
        {session.representation === "event-flow" ? (
          <EventFlowPreview
            source={session.source}
            flow={flow}
            view={eventFlowView}
            onViewChange={setEventFlowView}
            onNodeSelect={selectNode}
            onSemanticMessageSelect={selectIdentity}
            onSemanticOccurrenceSelect={selectOccurrence}
            activeNodeId={activeNodeId}
            activeSemanticMessageId={activeSemanticMessageId ?? selectedMessageId ?? counterpartMessageId}
          />
        ) : (
          <Preview
            source={session.source}
            onNodeSelect={selectNode}
            onSemanticMessageSelect={selectIdentity}
            onSemanticOccurrenceSelect={selectOccurrence}
            activeNodeId={activeNodeId}
            activeSemanticMessageId={activeSemanticMessageId ?? selectedMessageId ?? counterpartMessageId}
          />
        )}
      </div>
      <SemanticMessageInspector
        index={index}
        sequence={session.representation === "sequence" ? sequence : null}
        eventFlow={flow}
        activeResourceId={resourceId}
        activeNodeId={activeNodeId}
        activeSemanticMessageId={activeSemanticMessageId}
        onOpenResource={onOpenResource}
        onTrace={openTrace}
        counterpartResourceId={counterpartMessageId ? (pane === "a" ? comparison.occurrences.b[0]?.resourceId : comparison.occurrences.a[0]?.resourceId) ?? null : null}
        counterpartOccurrences={activeSemanticMessageId ? (pane === "a" ? comparison.occurrences.b : comparison.occurrences.a).filter((entry) => entry.messageId === activeSemanticMessageId) : []}
        onFocusOccurrence={onFocusOccurrence}
      />
      {traceStart && index ? <TraceExplorer index={index} start={traceStart} direction={traceDirection} onClose={() => setTraceStart(null)} onOpenResource={onOpenResource} /> : null}
    </section>
  );
}

export default function ComparisonView({
  primary,
  primarySource,
  diagrams,
  index,
  resourceIdForFile,
  onExit,
  onOpenResource,
  maximizedPane,
  onMaximize,
  onRestore,
  relationships = [],
}: ComparisonViewProps) {
  const [secondaryId, setSecondaryId] = useState<string | null>(() => diagrams.find((diagram) => diagram.id !== primary.id)?.id ?? null);
  const secondary = diagrams.find((diagram) => diagram.id === secondaryId) ?? null;
  useEffect(() => {
    if (secondaryId === primary.id || secondaryId === null) {
      setSecondaryId(diagrams.find((diagram) => diagram.id !== primary.id)?.id ?? null);
    }
  }, [diagrams, primary.id, secondaryId]);

  const primarySession: Session = {
    resource: primary,
    source: primarySource,
    representation: resourceRepresentationOfName(primary.name) === "event-flow" ? "event-flow" : "sequence",
  };
  const secondarySession = secondary ? {
    resource: secondary,
    source: secondary.source,
    representation: resourceRepresentationOfName(secondary.name) === "event-flow" ? "event-flow" : "sequence",
  } satisfies Session : null;
  const comparison = useMemo(
    () => semanticComparison(index, resourceIdForFile(primary), secondary ? resourceIdForFile(secondary) : null, relationships),
    [index, primary, resourceIdForFile, relationships, secondary],
  );
  const [selected, setSelected] = useState<{ pane: ComparisonPaneId; messageId: string } | null>(null);
  const [focused, setFocused] = useState<ComparisonOccurrence | null>(null);
  const selectedCounterparts = selected
    ? (selected.pane === "a" ? comparison.occurrences.b : comparison.occurrences.a).filter((entry) => entry.messageId === selected.messageId)
    : [];
  const focusNext = (direction: 1 | -1) => {
    if (!selected || selectedCounterparts.length === 0) return;
    const current = selectedCounterparts.findIndex((entry) => entry.nodeId === focused?.nodeId);
    const next = selectedCounterparts[(current + direction + selectedCounterparts.length) % selectedCounterparts.length];
    setFocused(next);
  };
  useEffect(() => {
    if (selected && !comparison.identities.has(selected.messageId)) setSelected(null);
    if (focused && !comparison.occurrences.a.concat(comparison.occurrences.b).some((entry) => entry.nodeId === focused.nodeId)) setFocused(null);
  }, [comparison, focused, selected]);
  const inspectIdentity = (pane: ComparisonPaneId, messageId: string) => {
    setSelected({ pane, messageId });
    setFocused(comparison.occurrences[pane].find((entry) => entry.messageId === messageId) ?? null);
  };

  return (
    <div className={`comparison${maximizedPane ? " comparison--maximized" : ""}`} data-testid="comparison-view">
      <header className="comparison__toolbar">
        <strong>Compare diagrams</strong>
        <label>Viewer B <select aria-label="Compare with" value={secondaryId ?? ""} onChange={(event) => setSecondaryId(event.target.value || null)}>
          <option value="">Select a diagram</option>
          {diagrams.filter((diagram) => diagram.id !== primary.id).map((diagram) => <option key={diagram.id} value={diagram.id}>{resourceLabel(diagram)}</option>)}
        </select></label>
        <button type="button" className="button button--ghost" onClick={onExit}>Close comparison</button>
      </header>
      <ComparisonSummary comparison={comparison} selected={selected} onSelect={inspectIdentity} onFocus={setFocused} onStep={focusNext} />
      <div className="comparison__panes">
        <div className={maximizedPane === "b" ? "comparison__slot comparison__slot--hidden" : "comparison__slot"}>
          <ComparisonPane pane="a" session={primarySession} index={index} resourceIdForFile={resourceIdForFile} maximized={maximizedPane === "a"} onMaximize={() => onMaximize("a")} onRestore={onRestore} onOpenResource={onOpenResource} comparison={comparison} selectedMessageId={selected?.pane === "a" ? selected.messageId : null} counterpartMessageId={selected?.pane === "b" ? selected.messageId : null} onSelectIdentity={(messageId) => { setSelected({ pane: "a", messageId }); setFocused(null); }} focusOccurrence={focused} onFocusOccurrence={setFocused} />
        </div>
        {secondarySession ? <div className={maximizedPane === "a" ? "comparison__slot comparison__slot--hidden" : "comparison__slot"}><ComparisonPane pane="b" session={secondarySession} index={index} resourceIdForFile={resourceIdForFile} maximized={maximizedPane === "b"} onMaximize={() => onMaximize("b")} onRestore={onRestore} onOpenResource={onOpenResource} comparison={comparison} selectedMessageId={selected?.pane === "b" ? selected.messageId : null} counterpartMessageId={selected?.pane === "a" ? selected.messageId : null} onSelectIdentity={(messageId) => { setSelected({ pane: "b", messageId }); setFocused(null); }} focusOccurrence={focused} onFocusOccurrence={setFocused} /></div> : <div className="comparison__empty">{secondaryId ? `Viewer B resource ${secondaryId} is no longer available.` : "Choose a second diagram to compare."}</div>}
      </div>
    </div>
  );
}

function ComparisonSummary({ comparison, selected, onSelect, onFocus, onStep }: { comparison: SemanticComparison; selected: { pane: ComparisonPaneId; messageId: string } | null; onSelect: (pane: ComparisonPaneId, id: string) => void; onFocus: (occurrence: ComparisonOccurrence) => void; onStep: (direction: 1 | -1) => void }) {
  const rows = [
    ["Shared identities", comparison.shared, "both"],
    ["Only in A", comparison.onlyA, "a"],
    ["Only in B", comparison.onlyB, "b"],
  ] as const;
  return <aside className="comparison__summary" aria-label="Semantic comparison summary" data-testid="semantic-comparison-summary">
    <div className="comparison__counts">{rows.map(([label, identities]) => <span key={label}>{label}: <strong>{identities.length}</strong></span>)}<span>Candidates/unresolved: <strong>{new Set(comparison.candidates.map((entry) => `${entry.kind}:${entry.name}`)).size}</strong></span></div>
    {comparison.relationship ? <p className="comparison__relationship">Complementary view: {comparison.relationship.sourceRole ?? "other"} ↔ {comparison.relationship.targetRole ?? "other"}</p> : null}
    {[...comparison.shared, ...comparison.onlyA, ...comparison.onlyB].map((identity) => {
      const pane = comparison.shared.includes(identity) ? ("both" as const) : comparison.onlyA.includes(identity) ? ("a" as const) : ("b" as const);
      const occurrences = pane === "both" ? [...comparison.occurrences.a, ...comparison.occurrences.b] : comparison.occurrences[pane];
      const matched = occurrences.filter((entry) => entry.messageId === identity.id);
      return <div className="comparison__identity" key={identity.id}>
        <button type="button" aria-label={`Inspect ${identity.kind} ${identity.name}`} onClick={() => onSelect(pane === "both" ? "a" : pane, identity.id)}>{identity.name} <small>{identity.kind} · {matched.length} occurrence{matched.length === 1 ? "" : "s"}</small></button>
        {selected?.messageId === identity.id && comparison.shared.includes(identity) ? <div className="comparison__sync-actions" aria-label={`Synchronization actions for ${identity.name}`}><button type="button" onClick={() => { const occurrence = comparison.occurrences[selected.pane === "a" ? "b" : "a"].find((entry) => entry.messageId === identity.id); if (occurrence) onFocus(occurrence); }}>Focus matching occurrence</button><button type="button" onClick={() => onStep(-1)} disabled={matched.length < 2}>Previous</button><button type="button" onClick={() => onStep(1)} disabled={matched.length < 2}>Next</button></div> : null}
      </div>;
    })}
    {comparison.candidates.length > 0 ? <p className="comparison__candidates">Unresolved candidates: {[...new Set(comparison.candidates.map((entry) => `${entry.kind} ${entry.name}`))].join(", ")}</p> : null}
  </aside>;
}
