import type {
  MetadataChange,
  SemanticChange,
  SourceDiff,
  SourceDiffHunk,
} from "../../domain/diff/resource-diff";
import type { ResourceRepresentation } from "../../domain/workspace/resource-id";

export type ReviewMode = "changes" | "compare" | "source";

export interface ReviewChangeTarget {
  id: string;
  kind: "metadata" | "semantic" | "source";
  change?: SemanticChange;
  metadata?: MetadataChange;
  source?: SourceDiffHunk;
}

/** Entities that the diagram renderers can decorate in compare mode. */
const EVENT_ENTITIES = new Set([
  "event",
  "event-metadata",
  "publication",
  "subscription",
  "channel",
]);

function comparableInDiagram(
  change: SemanticChange,
  representation: ResourceRepresentation,
): boolean {
  if (representation === "sequence")
    return change.entity === "interaction" || change.entity === "participant";
  if (representation === "event-flow") return EVENT_ENTITIES.has(change.entity);
  return false;
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

function sourceReviewTargets(source: SourceDiff): ReviewChangeTarget[] {
  return source.hunks.map((hunk, index) => ({
    id: `source:hunk:${index}`,
    kind: "source" as const,
    source: hunk,
  }));
}

/**
 * The targets a mode can actually reveal, so a mode never navigates to a
 * phantom location it cannot render:
 *
 * - Changes: every metadata and semantic change (each has a card).
 * - Compare: only semantic changes a diagram renderer decorates.
 * - Source: one target per diff hunk.
 */
export function navigableTargets(
  mode: ReviewMode,
  targets: ReviewChangeTarget[],
  source: SourceDiff,
  representation: ResourceRepresentation,
): ReviewChangeTarget[] {
  if (mode === "changes") return targets;
  if (mode === "compare")
    return targets.filter(
      (target) =>
        target.kind === "semantic" &&
        target.change != null &&
        comparableInDiagram(target.change, representation),
    );
  return sourceReviewTargets(source);
}
