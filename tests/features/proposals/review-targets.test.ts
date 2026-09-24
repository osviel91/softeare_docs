import { describe, expect, it } from "vitest";
import type { MetadataChange, SemanticChange } from "../../../src/domain/diff/resource-diff";
import { reviewChangeTargets } from "../../../src/features/proposals/review-targets";

describe("review change targets", () => {
  const cases: Array<[string, MetadataChange[], SemanticChange[], number]> = [
    ["empty", [], [], 0],
    ["one sequence interaction", [], [{ kind: "added", entity: "interaction", identity: "message:1" }], 1],
    ["one markdown block", [], [{ kind: "modified", entity: "markdown-block", identity: "lines:1" }], 1],
  ];

  it.each(cases)("returns the canonical count for %s", (_name, metadata, content, count) => {
    expect(reviewChangeTargets(metadata, content).length).toBe(count);
  });

  it("groups Event Flow event records into one navigable event target", () => {
    const targets = reviewChangeTargets([], [
      { kind: "added", entity: "event", identity: "OrderCreated" },
      {
        kind: "added",
        entity: "publication",
        identity: "OrderCreated|orders-service",
      },
    ]);
    expect(targets.map((target) => target.id)).toEqual(["event:OrderCreated"]);
  });

  it("keeps first, middle, and last targets in deterministic order", () => {
    const targets = reviewChangeTargets(
      [{ kind: "added", field: "description", identity: "description", newValue: "x" }],
      [
        { kind: "removed", entity: "interaction", identity: "message:1" },
        { kind: "modified", entity: "participant", identity: "Stage" },
      ],
    );
    expect(targets.map((target) => target.id)).toEqual([
      "metadata:description:description",
      "interaction:message:1",
      "participant:Stage",
    ]);
  });
});
