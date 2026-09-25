import type { ResourceType } from "./resource-id";

export type ResourceRelationshipKind = "complementary-view";
export type ResourceViewRole = "execution" | "causal" | "other";

export interface ResourceRelationship {
  kind: ResourceRelationshipKind;
  sourceId: string;
  targetId: string;
  sourceRole?: ResourceViewRole;
  targetRole?: ResourceViewRole;
}

export interface RelationshipResource {
  id: string;
  type: ResourceType;
}

export function normalizeResourceRelationship(
  relationship: ResourceRelationship,
): ResourceRelationship {
  if (relationship.sourceId === relationship.targetId) {
    throw new Error("A resource cannot be complementary to itself.");
  }
  if (relationship.sourceId > relationship.targetId) {
    return {
      ...relationship,
      sourceId: relationship.targetId,
      targetId: relationship.sourceId,
      sourceRole: relationship.targetRole,
      targetRole: relationship.sourceRole,
    };
  }
  return { ...relationship };
}

export function validateResourceRelationship(
  relationship: ResourceRelationship,
  resources: RelationshipResource[],
): ResourceRelationship {
  if (relationship.kind !== "complementary-view") {
    throw new Error(`Unsupported resource relationship: ${relationship.kind}.`);
  }
  const normalized = normalizeResourceRelationship(relationship);
  const source = resources.find((resource) => resource.id === normalized.sourceId);
  const target = resources.find((resource) => resource.id === normalized.targetId);
  if (!source || !target) throw new Error("Both relationship resources must exist.");
  if (
    !(
      (source.type === "sequence-diagram" && target.type === "event-flow") ||
      (source.type === "event-flow" && target.type === "sequence-diagram")
    )
  ) {
    throw new Error("Complementary views currently require a Sequence and an Event Flow.");
  }
  return normalized;
}

export function sameResourceRelationship(
  left: ResourceRelationship,
  right: ResourceRelationship,
): boolean {
  return (
    left.kind === right.kind &&
    left.sourceId === right.sourceId &&
    left.targetId === right.targetId
  );
}
