import { describe, expect, it } from "vitest";
import { decorateReviewSvg } from "../../../src/features/proposals/review-decorations";

describe("review SVG decoration", () => {
  it("marks a modified sequence interaction as removed in BASE and added in PROPOSED", () => {
    const svg =
      '<line data-node-id="message:1"/><g class="sequence-number" data-sequence-number="1"></g>';
    const change = {
      kind: "modified" as const,
      entity: "interaction",
      identity: "message:1",
    };

    expect(decorateReviewSvg(svg, "sequence", [change], "base")).toContain(
      'class="review-change--removed"',
    );
    expect(decorateReviewSvg(svg, "sequence", [change], "proposed")).toContain(
      'class="review-change--added"',
    );
    expect(decorateReviewSvg(svg, "sequence", [change])).toContain(
      'data-review-change="message:1"',
    );
  });

  it("marks event-flow additions and removals without changing the SVG structure", () => {
    const svg = '<g class="eventflow-row" data-event="OrderCreated"></g>';
    const changes = [
      { kind: "added" as const, entity: "event", identity: "OrderCreated" },
      { kind: "removed" as const, entity: "event", identity: "OrderDeleted" },
    ];

    const decorated = decorateReviewSvg(svg, "event-flow", changes);
    expect(decorated).toContain("review-change--added");
    expect(decorated).not.toContain("review-change--removed");
    expect(decorated).toContain('data-event="OrderCreated"');
  });
});
