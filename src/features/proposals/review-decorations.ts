import type { SemanticChange } from "../../domain/diff/resource-diff";
import { reviewTargetId } from "./review-targets";

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Adds review-only classes to renderer-owned addressable SVG entities. */
export function decorateReviewSvg(
  svg: string,
  representation: "sequence" | "event-flow",
  changes: SemanticChange[],
  side: "base" | "proposed" = "proposed",
): string {
  let result = svg;
  for (const change of changes) {
    const event = typeof change.details?.event === "string"
      ? change.details.event
      : change.entity === "event"
        ? change.identity
        : change.entity === "publication" || change.entity === "subscription"
          ? change.identity.split("|")[0]
          : change.entity === "channel"
            ? change.identity
            : null;
    const identity =
      change.entity === "publication" || change.entity === "subscription"
        ? change.identity.split("|")[0]
        : (event ?? change.identity);
    const visualKind =
      change.kind === "modified"
        ? side === "base"
          ? "removed"
          : "added"
        : change.kind;
    const kind = `review-change--${visualKind}`;
    const targetIdentity = reviewTargetId(change);
    const markerAttribute = ` data-review-change="${xml(targetIdentity)}"`;
    if (representation === "event-flow" && identity) {
      const marker = `class="eventflow-row" data-event="${xml(identity)}"`;
      result = result.replace(
        marker,
       `class="eventflow-row ${kind}" data-event="${xml(identity)}"${markerAttribute}`,
      );
    }
    if (representation === "sequence" && change.entity === "interaction") {
      const number = change.identity.replace("message:", "");
      result = result.replace(
        `class="sequence-number" data-sequence-number="${xml(number)}"`,
        `class="sequence-number ${kind}" data-sequence-number="${xml(number)}"${markerAttribute}`,
      );
      const nodeMarker = `data-node-id="${xml(change.identity)}"`;
      result = result.replace(
        new RegExp(`(<(?:line|path)[^>]*${nodeMarker}[^>]*)(/>)`),
        `$1 class="${kind}"${markerAttribute}$2`,
      );
    }
    if (representation === "sequence" && change.entity === "participant") {
      const marker = `data-participant-id="${xml(change.identity)}"`;
      result = result.replace(
        new RegExp(`(<g class="participant)([^"]*)("[^>]*${marker}[^>]*)(>)`),
        `$1$2 ${kind}$3${markerAttribute}$4`,
      );
    }
  }
  return result;
}
