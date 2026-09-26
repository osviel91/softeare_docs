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
}: {
  pane: Pane;
  session: Session;
  index: ProjectIndex | null;
  resourceIdForFile: (file: DiagramFile) => string | null;
  maximized: boolean;
  onMaximize: () => void;
  onRestore: () => void;
  onOpenResource: (resourceId: string, nodeId?: string) => void;
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

  const selectNode = (nodeId: string) => {
    setActiveNodeId(nodeId);
    setActiveSemanticMessageId(null);
  };
  const selectIdentity = (messageId: string, nodeId: string | null) => {
    setActiveSemanticMessageId(messageId);
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
            activeSemanticMessageId={activeSemanticMessageId}
          />
        ) : (
          <Preview
            source={session.source}
            onNodeSelect={selectNode}
            onSemanticMessageSelect={selectIdentity}
            onSemanticOccurrenceSelect={selectOccurrence}
            activeNodeId={activeNodeId}
            activeSemanticMessageId={activeSemanticMessageId}
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
      <div className="comparison__panes">
        <div className={maximizedPane === "b" ? "comparison__slot comparison__slot--hidden" : "comparison__slot"}>
          <ComparisonPane pane="a" session={primarySession} index={index} resourceIdForFile={resourceIdForFile} maximized={maximizedPane === "a"} onMaximize={() => onMaximize("a")} onRestore={onRestore} onOpenResource={onOpenResource} />
        </div>
        {secondarySession ? <div className={maximizedPane === "a" ? "comparison__slot comparison__slot--hidden" : "comparison__slot"}><ComparisonPane pane="b" session={secondarySession} index={index} resourceIdForFile={resourceIdForFile} maximized={maximizedPane === "b"} onMaximize={() => onMaximize("b")} onRestore={onRestore} onOpenResource={onOpenResource} /></div> : <div className="comparison__empty">{secondaryId ? `Viewer B resource ${secondaryId} is no longer available.` : "Choose a second diagram to compare."}</div>}
      </div>
    </div>
  );
}
