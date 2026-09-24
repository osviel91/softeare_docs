import type {
  MetadataChange,
  SemanticChange,
} from "../../domain/diff/resource-diff";

export interface ReviewChangeTarget {
  id: string;
  kind: "metadata" | "semantic";
  change?: SemanticChange;
  metadata?: MetadataChange;
}

function eventOf(change: SemanticChange): string | null {
  if (typeof change.details?.event === "string") return change.details.event;
  if (change.entity === "event") return change.identity;
  if (change.entity === "publication" || change.entity === "subscription")
    return change.identity.split("|")[0];
  return null;
}

export function reviewTargetId(change: SemanticChange): string {
  if (change.entity === "interaction") return `interaction:${change.identity}`;
  if (change.entity === "participant") return `participant:${change.identity}`;
  const event = eventOf(change);
  if (
    event !== null &&
    ["event", "event-metadata", "publication", "subscription", "channel"].includes(
      change.entity,
    )
  )
    return `event:${event}`;
  return change.identity;
}

/** Build the user-navigable review locations shared by Changes and Compare. */
export function reviewChangeTargets(
  metadata: MetadataChange[],
  content: SemanticChange[],
): ReviewChangeTarget[] {
  const targets: ReviewChangeTarget[] = metadata.map((change) => ({
    id: `metadata:${change.field}:${change.identity}`,
    kind: "metadata",
    metadata: change,
  }));
  const grouped = new Map<string, SemanticChange>();
  for (const change of content) {
    const event = eventOf(change);
    const id = reviewTargetId(change);
    const previous = grouped.get(id);
    grouped.set(
      id,
      previous
        ? {
            ...previous,
            entity: "event",
            identity: event ?? previous.identity,
            details: { ...previous.details, related: true },
          }
        : { ...change },
    );
  }
  for (const [id, change] of grouped) {
    targets.push({ id, kind: "semantic", change });
  }
  return targets;
}
