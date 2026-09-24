import type { SemanticChange } from "../../domain/diff/resource-diff";

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
    const event =
      typeof change.details?.event === "string"
        ? change.details.event
        : change.entity === "event"
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
    const markerAttribute = ` data-review-change="${xml(change.identity)}"`;
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
  }
  return result;
}
