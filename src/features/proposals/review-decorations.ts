import type { SemanticChange } from "../../domain/diff/resource-diff";

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Adds review-only classes to renderer-owned addressable SVG entities. */
export function decorateReviewSvg(
  svg: string,
  representation: "sequence" | "event-flow",
  changes: SemanticChange[],
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
    const kind = `review-change--${change.kind}`;
    if (representation === "event-flow" && identity) {
      const marker = `class="eventflow-row" data-event="${xml(identity)}"`;
      result = result.replace(
        marker,
        `class="eventflow-row ${kind}" data-event="${xml(identity)}"`,
      );
    }
    if (representation === "sequence" && change.entity === "interaction") {
      const number = change.identity.replace("message:", "");
      result = result.replace(
        `class="sequence-number" data-sequence-number="${xml(number)}"`,
        `class="sequence-number ${kind}" data-sequence-number="${xml(number)}"`,
      );
    }
  }
  return result;
}
