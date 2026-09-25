import type { MessageKind } from "../eventflow/ast";
import type { ProjectIndex } from "./project-index";

export interface SemanticMessageCandidate {
  name: string;
  kind: MessageKind;
  sequenceResources: string[];
  eventFlowResources: string[];
  authoritative: boolean;
}

/** Name equality is discovery evidence only; this function never mutates an index. */
export function semanticMessageCandidates(index: ProjectIndex): SemanticMessageCandidate[] {
  const candidates = new Map<string, SemanticMessageCandidate>();
  for (const occurrence of index.semanticOccurrences ?? []) {
    const key = `${occurrence.kind}:${occurrence.name}`.toLowerCase();
    const current = candidates.get(key) ?? {
      name: occurrence.name,
      kind: occurrence.kind,
      sequenceResources: [],
      eventFlowResources: [],
      authoritative: false,
    };
    if (!current.sequenceResources.includes(occurrence.resourceId)) current.sequenceResources.push(occurrence.resourceId);
    current.authoritative ||= Boolean(occurrence.messageRef && (index.semanticMessages ?? []).some((message) => message.id === occurrence.messageRef));
    candidates.set(key, current);
  }
  for (const entity of index.eventFlowMessages ?? []) {
    const key = `${entity.kind}:${entity.name}`.toLowerCase();
    const current = candidates.get(key) ?? {
      name: entity.name,
      kind: entity.kind,
      sequenceResources: [],
      eventFlowResources: [],
      authoritative: false,
    };
    if (!current.eventFlowResources.includes(entity.resourceId)) current.eventFlowResources.push(entity.resourceId);
    current.authoritative ||= Boolean(entity.messageRef && (index.semanticMessages ?? []).some((message) => message.id === entity.messageRef));
    candidates.set(key, current);
  }
  return [...candidates.values()];
}

export function traceSemanticMessage(index: ProjectIndex, id: string) {
  const identity = (index.semanticMessages ?? []).find((message) => message.id === id) ?? null;
  return {
    identity,
    occurrences: (index.semanticOccurrences ?? []).filter((occurrence) => occurrence.messageRef === id),
    eventFlowEntities: (index.eventFlowMessages ?? []).filter((entity) => entity.messageRef === id),
  };
}
