import { describe, expect, it } from "vitest";
import { decorateReviewSvg } from "../../../src/features/proposals/review-decorations";

describe("review SVG decorations", () => {
  it("marks changed event rows without changing their geometry", () => {
    const svg =
      '<svg><g class="eventflow-row" data-event="Checkout"><rect /></g></svg>';
    const decorated = decorateReviewSvg(svg, "event-flow", [
      { kind: "removed", entity: "event", identity: "Checkout" },
    ]);
    expect(decorated).toContain("review-change--removed");
    expect(decorated).toContain('data-event="Checkout"');
  });

  it("marks conservatively identified sequence interactions", () => {
    const svg =
      '<svg><g class="sequence-number" data-sequence-number="2" /></svg>';
    expect(
      decorateReviewSvg(svg, "sequence", [
        { kind: "modified", entity: "interaction", identity: "message:2" },
      ]),
    ).toContain("review-change--modified");
  });
});
