import { describe, expect, it } from "vitest";
import { analyzeResourceMerge } from "../../../src/domain/diff/merge-analysis";
import type { ResourceState } from "../../../src/domain/diff/resource-state";

const state = (
  content: string,
  type: ResourceState["type"] = "markdown-document",
  metadata?: ResourceState["metadata"],
): ResourceState => ({
  content,
  type,
  ...(metadata === undefined ? {} : { metadata }),
});

const analyze = (
  base: ResourceState,
  current: ResourceState,
  proposed: ResourceState,
) =>
  analyzeResourceMerge({
    base,
    current,
    proposed,
    baseRevision: 10,
    currentRevision: 12,
    proposalVersion: 2,
  });

describe("resource merge analysis", () => {
  it("distinguishes stale independent changes from conflicts", () => {
    const result = analyze(
      state("base", "markdown-document", { tags: ["payments"] }),
      state("base", "markdown-document", { tags: ["payments", "production"] }),
      state("Payment architecture", "markdown-document", {
        tags: ["payments"],
      }),
    );
    expect(result).toMatchObject({
      stale: true,
      status: "ok",
      autoMergeable: true,
    });
    expect(result.candidateState).toEqual({
      content: "Payment architecture",
      type: "markdown-document",
      metadata: { tags: ["payments", "production"] },
    });
  });

  it("reports incompatible metadata edits", () => {
    const result = analyze(
      state("same", "markdown-document", { description: "A" }),
      state("same", "markdown-document", { description: "B" }),
      state("same", "markdown-document", { description: "C" }),
    );
    expect(result.autoMergeable).toBe(false);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        entity: "metadata",
        identity: "description",
        kind: "concurrent-modification",
        base: "A",
        current: "B",
        proposed: "C",
      }),
    ]);
  });

  it("merges independent event-flow relationship additions", () => {
    const base = "event OrderCreated\nproducer Orders\nconsumer Billing";
    const current = `${base}\nconsumer Analytics`;
    const proposed = `${base}\nconsumer Notifications`;
    const result = analyze(
      state(base, "event-flow"),
      state(current, "event-flow"),
      state(proposed, "event-flow"),
    );
    expect(result.autoMergeable).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.candidateState?.content).toContain("consumer Analytics");
    expect(result.candidateState?.content).toContain("consumer Notifications");
  });

  it("detects event channel conflicts", () => {
    const base =
      "event OrderCreated\ntopic orders\nproducer Orders\nOrders publishes OrderCreated to orders";
    const current =
      "event OrderCreated\ntopic payments\nproducer Orders\nOrders publishes OrderCreated to payments";
    const proposed =
      "event OrderCreated\ntopic kafka\nproducer Orders\nOrders publishes OrderCreated to kafka";
    const result = analyze(
      state(base, "event-flow"),
      state(current, "event-flow"),
      state(proposed, "event-flow"),
    );
    expect(result.autoMergeable).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it("treats invalid proposals as diagnostics, not semantic conflicts", () => {
    const result = analyze(state("# base"), state("# current"), state("# ["));
    expect(result.status).toBe("ok");
    const eventResult = analyze(
      state("event Good", "event-flow"),
      state("event Good", "event-flow"),
      state("event {", "event-flow"),
    );
    expect(eventResult.status).toBe("invalid-proposed");
    expect(eventResult.conflicts).toEqual([]);
  });

  it("is deterministic for conservative sequence edits", () => {
    const base = "participant A\nparticipant B\nA -> B: one";
    const current = `${base}\nparticipant C`;
    const proposed = `${base}\nparticipant D`;
    const first = analyze(
      state(base, "sequence-diagram"),
      state(current, "sequence-diagram"),
      state(proposed, "sequence-diagram"),
    );
    expect(first).toEqual(
      analyze(
        state(base, "sequence-diagram"),
        state(current, "sequence-diagram"),
        state(proposed, "sequence-diagram"),
      ),
    );
  });
});
