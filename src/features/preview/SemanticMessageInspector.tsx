import type { SequenceDiagram } from "../../domain/diagram/ast";
import { nodeIdOf } from "../../domain/diagram/node-id";
import { semanticMessagesOf } from "../../domain/diagram/semantic-messages";
import type { EventFlow } from "../../domain/eventflow/ast";
import { eventsOf } from "../../domain/eventflow/ast";
import type { ProjectIndex } from "../../domain/project/project-index";
import { traceSemanticMessage } from "../../domain/project/semantic-message-trace";

interface Props {
  index: ProjectIndex | null;
  sequence?: SequenceDiagram | null;
  eventFlow?: EventFlow | null;
  activeResourceId: string | null;
  activeNodeId: string | null;
  activeSemanticMessageId?: string | null;
  onOpenResource: (resourceId: string, nodeId?: string) => void;
}

/** Compact, authoritative-only cross-view details for the selected message. */
export default function SemanticMessageInspector({
  index,
  sequence,
  eventFlow,
  activeResourceId,
  activeNodeId,
  activeSemanticMessageId,
  onOpenResource,
}: Props) {
  if (!index || !activeResourceId || !activeNodeId) return null;
  const occurrence = sequence
    ? semanticMessagesOf(sequence).find((entry) => nodeIdOf("message", entry.range) === activeNodeId && entry.messageRef)
    : undefined;
  const event = eventFlow
    ? eventsOf(eventFlow).find((entry) => nodeIdOf("event", entry.range) === activeNodeId && entry.messageRef)
    : undefined;
  const currentMessageId = occurrence?.messageRef ?? event?.messageRef;
  if (activeSemanticMessageId && currentMessageId !== activeSemanticMessageId) return null;
  const messageId = activeSemanticMessageId ?? currentMessageId;
  if (!messageId) return null;
  const trace = traceSemanticMessage(index, messageId);
  if (!trace.identity) return null;
  const resources = new Map(index.resources.map((resource) => [resource.id, resource]));
  const provenance = event?.provenance ?? "unknown";
  return (
    <aside className="semantic-message-inspector" aria-label="Semantic message trace" data-testid="semantic-message-inspector">
      <div className="semantic-message-inspector__heading">
        <strong>{trace.identity.name}</strong>
        <span>{trace.identity.kind} · {occurrence?.operation ?? "represented"}</span>
      </div>
      <div className="semantic-message-inspector__section">
        <span className="semantic-message-inspector__label">Architectural message</span>
        <span>{trace.identity.name}</span>
        <span>Provenance: {provenance}</span>
      </div>
      <div className="semantic-message-inspector__section">
        <span className="semantic-message-inspector__label">Execution</span>
        {trace.occurrences.length === 0 ? <span>No execution occurrence documented</span> : trace.occurrences.map((entry) => (
          <button aria-label={resources.get(entry.resourceId)?.title ?? entry.resourceId} key={`${entry.resourceId}:${entry.step}`} type="button" onClick={() => onOpenResource(entry.resourceId, nodeIdOf("message", entry.range))}>
            {resources.get(entry.resourceId)?.title ?? entry.resourceId} · Step {entry.step} · {entry.operation}{entry.resourceId === activeResourceId && entry.range.start.line === occurrence?.range.start.line ? " (current)" : ""}
          </button>
        ))}
      </div>
      <div className="semantic-message-inspector__section">
        <span className="semantic-message-inspector__label">Causal</span>
        {trace.eventFlowEntities.length === 0 ? <span>No causal representation documented</span> : trace.eventFlowEntities.map((entry) => (
          <button aria-label={resources.get(entry.resourceId)?.title ?? entry.resourceId} key={`${entry.resourceId}:${entry.nodeId ?? entry.sourceRange?.start.line}`} type="button" onClick={() => onOpenResource(entry.resourceId, entry.nodeId)}>
            {resources.get(entry.resourceId)?.title ?? entry.resourceId} · {entry.kind} {entry.name}
          </button>
        ))}
      </div>
    </aside>
  );
}
