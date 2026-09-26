import { nodeIdOf } from "../../domain/diagram/node-id";
import type { ProjectIndex } from "../../domain/project/project-index";
import type { SemanticMessageIdentity } from "../../domain/workspace/metadata";
import type { ResourceRelationship } from "../../domain/workspace/resource-relationship";

export type ComparisonPane = "a" | "b";

export interface ComparisonOccurrence {
  resourceId: string;
  messageId?: string;
  name: string;
  kind: "event" | "command";
  operation?: "publish" | "consume" | "dispatch";
  nodeId: string;
  step?: number;
}

export interface SemanticComparison {
  occurrences: Record<ComparisonPane, ComparisonOccurrence[]>;
  identities: Map<string, SemanticMessageIdentity>;
  shared: SemanticMessageIdentity[];
  onlyA: SemanticMessageIdentity[];
  onlyB: SemanticMessageIdentity[];
  candidates: ComparisonOccurrence[];
  relationship: ResourceRelationship | null;
}

function occurrencesFor(index: ProjectIndex, resourceId: string): ComparisonOccurrence[] {
  const sequence = (index.semanticOccurrences ?? [])
    .filter((entry) => entry.resourceId === resourceId)
    .map((entry) => ({
      resourceId,
      messageId: entry.messageRef,
      name: entry.name,
      kind: entry.kind,
      operation: entry.operation,
      nodeId: nodeIdOf("message", entry.range),
      step: entry.step,
    }));
  const flow = (index.eventFlowMessages ?? [])
    .filter((entry) => entry.resourceId === resourceId)
    .map((entry) => ({
      resourceId,
      messageId: entry.messageRef,
      name: entry.name,
      kind: entry.kind,
      nodeId: entry.nodeId ?? nodeIdOf("event", entry.sourceRange!),
    }));
  return [...sequence, ...flow];
}

export function semanticComparison(
  index: ProjectIndex | null,
  resourceA: string | null,
  resourceB: string | null,
  relationships: ResourceRelationship[] = [],
): SemanticComparison {
  const empty: SemanticComparison = {
    occurrences: { a: [], b: [] }, identities: new Map(), shared: [], onlyA: [], onlyB: [], candidates: [], relationship: null,
  };
  if (!index || !resourceA || !resourceB) return empty;
  const occurrences = {
    a: occurrencesFor(index, resourceA),
    b: occurrencesFor(index, resourceB),
  };
  const identities = new Map((index.semanticMessages ?? []).map((identity) => [identity.id, identity]));
  const isAuthoritative = (entry: ComparisonOccurrence) => Boolean(
    entry.messageId && identities.get(entry.messageId)?.kind === entry.kind,
  );
  const idsA = new Set(occurrences.a.filter(isAuthoritative).map((entry) => entry.messageId!));
  const idsB = new Set(occurrences.b.filter(isAuthoritative).map((entry) => entry.messageId!));
  const shared = [...idsA].filter((id) => idsB.has(id)).map((id) => identities.get(id)!);
  const onlyA = [...idsA].filter((id) => !idsB.has(id)).map((id) => identities.get(id)!);
  const onlyB = [...idsB].filter((id) => !idsA.has(id)).map((id) => identities.get(id)!);
  const candidates = [...occurrences.a, ...occurrences.b].filter((entry) => !isAuthoritative(entry));
  const relationship = relationships.find((entry) =>
    (entry.sourceId === resourceA && entry.targetId === resourceB) ||
    (entry.sourceId === resourceB && entry.targetId === resourceA),
  ) ?? null;
  return { occurrences, identities, shared, onlyA, onlyB, candidates, relationship };
}
