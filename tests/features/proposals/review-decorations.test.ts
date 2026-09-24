import { describe, expect, it } from "vitest";
import { decorateReviewSvg } from "../../../src/features/proposals/review-decorations";

describe("review SVG decoration", () => {
  it("marks a modified sequence interaction as removed in BASE and added in PROPOSED", () => {
    const svg =
      '<g class="sequence-message" data-sequence-message="1"><line data-node-id="message@0:1"/><polygon points="0,0 1,1"/><text>x</text></g>';
    const change = {
      kind: "modified" as const,
      entity: "interaction",
      identity: "message:1-1",
      details: {
        baseNumber: 1,
        proposedNumber: 1,
        old: { from: "A", to: "B", label: "old", arrowStyle: "arrow", lineStyle: "solid" },
        new: { from: "A", to: "B", label: "new", arrowStyle: "arrow", lineStyle: "solid" },
      },
    };

    expect(decorateReviewSvg(svg, "sequence", [change], "base")).toContain(
      'class="sequence-message review-change--removed"',
    );
    expect(decorateReviewSvg(svg, "sequence", [change], "proposed")).toContain(
      'class="sequence-message review-change--added"',
    );
    expect(decorateReviewSvg(svg, "sequence", [change])).toContain(
      'data-review-change="interaction:message:1-1"',
    );
  });

  it("decorates an added interaction only where it is rendered", () => {
    const change = {
      kind: "added" as const,
      entity: "interaction",
      identity: "message:0-2",
      details: {
        baseNumber: 0,
        proposedNumber: 2,
        old: null,
        new: { from: "A", to: "B", label: "two", arrowStyle: "arrow", lineStyle: "solid" },
      },
    };
    const proposedSvg =
      '<g class="sequence-message" data-sequence-message="2"><line/></g>';
    expect(decorateReviewSvg(proposedSvg, "sequence", [change], "proposed")).toContain(
      "review-change--added",
    );
    const baseSvg =
      '<g class="sequence-message" data-sequence-message="1"><line/></g>';
    expect(decorateReviewSvg(baseSvg, "sequence", [change], "base")).not.toContain(
      "data-review-change",
    );
  });

  it("marks a changed participant without changing canonical SVG structure", () => {
    const svg =
      '<g class="participant" data-participant-id="Stage" draggable="true"></g>';
    const change = {
      kind: "modified" as const,
      entity: "participant",
      identity: "Stage",
    };
    const decorated = decorateReviewSvg(svg, "sequence", [change], "proposed");
    expect(decorated).toContain("review-change--added");
    expect(decorated).toContain('data-review-change="participant:Stage"');
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
