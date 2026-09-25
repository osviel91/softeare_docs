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
  onOpenResource: (resourceId: string) => void;
}

/** Compact, authoritative-only cross-view details for the selected message. */
export default function SemanticMessageInspector({
  index,
  sequence,
  eventFlow,
  activeResourceId,
  activeNodeId,
  onOpenResource,
}: Props) {
  if (!index || !activeResourceId || !activeNodeId) return null;
  const occurrence = sequence
    ? semanticMessagesOf(sequence).find((entry) => nodeIdOf("message", entry.range) === activeNodeId && entry.messageRef)
    : undefined;
  const event = eventFlow
    ? eventsOf(eventFlow).find((entry) => nodeIdOf("event", entry.range) === activeNodeId && entry.messageRef)
    : undefined;
  const messageId = occurrence?.messageRef ?? event?.messageRef;
  if (!messageId) return null;
  const trace = traceSemanticMessage(index, messageId);
  if (!trace.identity) return null;
  const otherOccurrences = trace.occurrences.filter((entry) => !(entry.resourceId === activeResourceId && entry.range.start.line === (occurrence?.range.start.line ?? -1)));
  const otherFlows = trace.eventFlowEntities.filter((entry) => entry.resourceId !== activeResourceId);
  return (
    <aside className="semantic-message-inspector" aria-label="Semantic message trace" data-testid="semantic-message-inspector">
      <div className="semantic-message-inspector__heading">
        <strong>{trace.identity.name}</strong>
        <span>{trace.identity.kind} · {occurrence?.operation ?? "represented"}</span>
      </div>
      <div className="semantic-message-inspector__section">
        <span className="semantic-message-inspector__label">Architectural message</span>
        <span>{trace.identity.name}</span>
      </div>
      {otherOccurrences.length > 0 && (
        <div className="semantic-message-inspector__section">
          <span className="semantic-message-inspector__label">Other occurrences</span>
          {otherOccurrences.map((entry) => (
            <button key={`${entry.resourceId}:${entry.step}`} type="button" onClick={() => onOpenResource(entry.resourceId)}>
              Step {entry.step} · {entry.operation}
            </button>
          ))}
        </div>
      )}
      {otherFlows.length > 0 && (
        <div className="semantic-message-inspector__section">
          <span className="semantic-message-inspector__label">Event Flow representations</span>
          {otherFlows.map((entry) => (
            <button key={entry.resourceId} type="button" onClick={() => onOpenResource(entry.resourceId)}>
              {index.resources.find((resource) => resource.id === entry.resourceId)?.title ?? entry.resourceId}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
