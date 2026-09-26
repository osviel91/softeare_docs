import { useMemo, useState } from "react";
import {
  traceArchitectureQuery,
  type TraceDirection,
  type TraceNode,
  type TraceQueryStart,
} from "../../domain/project/architecture-trace";
import type { ProjectIndex } from "../../domain/project/project-index";

interface Props {
  index: ProjectIndex;
  start: TraceQueryStart;
  direction?: TraceDirection;
  onClose: () => void;
  onOpenResource: (resourceId: string, nodeId?: string) => void;
}

const nodeType: Record<TraceNode["kind"], string> = {
  identity: "semantic identity",
  "execution-occurrence": "sequence occurrence",
  "causal-message": "event",
  handler: "handler",
  effect: "effect",
  failure: "failure",
  retry: "retry",
  "unknown-boundary": "unknown boundary",
};

function typeOf(node: TraceNode): string {
  return node.kind === "causal-message" ? node.messageKind : nodeType[node.kind];
}

function labelFor(index: ProjectIndex, id: string): string {
  const resource = index.resources.find((entry) => entry.id === id);
  return resource?.title ?? id;
}

function TraceNodeCard({
  node,
  onOpenResource,
  selected,
  onSelect,
}: {
  node: TraceNode;
  onOpenResource: Props["onOpenResource"];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`trace-explorer__node trace-explorer__node--${node.kind} trace-explorer__node--${node.confidence}${selected ? " is-selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
      data-testid={`trace-node-${node.id}`}
    >
      <span className="trace-explorer__node-type">{typeOf(node)}</span>
      <strong>{node.label}</strong>
      <span className="trace-explorer__node-confidence">{node.confidence}</span>
      {node.source ? (
        <span
          className="trace-explorer__node-source"
          onClick={(event) => {
            event.stopPropagation();
            onOpenResource(node.source!.resourceId, node.source!.nodeId);
          }}
        >
          {node.source.resourcePath ?? node.source.resourceId}
        </span>
      ) : null}
    </button>
  );
}

export default function TraceExplorer({
  index,
  start,
  direction: initialDirection = "both",
  onClose,
  onOpenResource,
}: Props) {
  const [direction, setDirection] = useState<TraceDirection>(initialDirection);
  const [maxDepth, setMaxDepth] = useState(8);
  const [maxNodes, setMaxNodes] = useState(120);
  const [includeCandidates, setIncludeCandidates] = useState(false);
  const [includeRecovery, setIncludeRecovery] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const result = useMemo(
    () => traceArchitectureQuery(index, start, { direction, maxDepth, maxNodes, includeCandidates, includeRecovery }),
    [index, start, direction, maxDepth, maxNodes, includeCandidates, includeRecovery],
  );
  const trace = result.trace;
  const nodeById = useMemo(() => new Map(trace?.nodes.map((node) => [node.id, node]) ?? []), [trace]);
  const selected = selectedNode ? nodeById.get(selectedNode) : undefined;

  return (
    <section className="trace-explorer" aria-label="Trace Explorer" data-testid="trace-explorer">
      <header className="trace-explorer__header">
        <div>
          <span className="trace-explorer__eyebrow">Architectural trace</span>
          <h2>{trace ? (nodeById.get(trace.selected)?.label ?? "Selected message") : "Unresolved starting point"}</h2>
        </div>
        <button type="button" className="button button--ghost button--small" onClick={onClose}>Close</button>
      </header>
      <div className="trace-explorer__controls">
        <label>Direction <select value={direction} onChange={(event) => setDirection(event.target.value as TraceDirection)}>
          <option value="upstream">Upstream</option><option value="downstream">Downstream</option><option value="both">Both</option>
        </select></label>
        <label>Depth <input type="number" min="0" max="32" value={maxDepth} onChange={(event) => setMaxDepth(Number(event.target.value))} /></label>
        <label>Nodes <input type="number" min="1" max="5000" value={maxNodes} onChange={(event) => setMaxNodes(Number(event.target.value))} /></label>
        <label><input type="checkbox" checked={includeCandidates} onChange={(event) => setIncludeCandidates(event.target.checked)} /> Candidates</label>
        <label><input type="checkbox" checked={includeRecovery} onChange={(event) => setIncludeRecovery(event.target.checked)} /> Failures/retries</label>
      </div>
      {result.resolution.status !== "authoritative" ? (
        <div className="trace-explorer__notice" data-testid="trace-resolution">
          <strong>{result.resolution.status === "candidate" ? "Candidate starting point" : "Unknown starting point"}</strong>
          <span>{result.resolution.reason === "unbound-start" ? "This occurrence has no explicit semantic identity binding." : "No authoritative identity was found."}</span>
          {result.resolution.candidates.length > 0 ? <span>{result.resolution.candidates.length} name matches are candidates only.</span> : null}
        </div>
      ) : null}
      {trace ? (
        <>
          <div className="trace-explorer__legend" aria-label="Trace legend">
            <span className="trace-explorer__legend-item trace-explorer__legend-item--authoritative">authoritative</span>
            <span className="trace-explorer__legend-item trace-explorer__legend-item--candidate">candidate</span>
            <span className="trace-explorer__legend-item trace-explorer__legend-item--unknown">unknown boundary</span>
          </div>
          <div className="trace-explorer__graph" role="list" aria-label="Architectural trace graph">
            {trace.nodes.map((node) => <TraceNodeCard key={node.id} node={node} selected={node.id === selectedNode} onSelect={() => setSelectedNode(node.id)} onOpenResource={onOpenResource} />)}
          </div>
          <div className="trace-explorer__edges" aria-label="Trace relationships">
            {trace.edges.map((edge) => (
              <div key={edge.id} className={`trace-explorer__edge trace-explorer__edge--${edge.confidence}${edge.cycleReference ? " trace-explorer__edge--cycle" : ""}`}>
                <span>{nodeById.get(edge.from)?.label ?? edge.from}</span><b>→</b><span>{nodeById.get(edge.to)?.label ?? edge.to}</span>
                <small>{edge.kind}{edge.cycleReference ? " · cycle reference" : ""}</small>
              </div>
            ))}
          </div>
          {trace.truncated ? <p className="trace-explorer__notice">Exploration is bounded at depth {trace.limits.maxDepth} or {trace.limits.maxNodes} nodes.</p> : null}
          {selected ? <aside className="trace-explorer__details" aria-label="Selected trace context"><strong>{selected.label}</strong><span>{typeOf(selected)} · {selected.confidence}</span>{selected.source ? <button type="button" onClick={() => onOpenResource(selected.source!.resourceId, selected.source!.nodeId)}>Open {selected.source.resourcePath ?? labelFor(index, selected.source.resourceId)}</button> : <span>No exact source is documented.</span>}</aside> : null}
        </>
      ) : null}
    </section>
  );
}
