import { describe, expect, it } from "vitest";
import { diffResources } from "../../../src/domain/diff/resource-diff";
import type { ResourceState } from "../../../src/domain/diff/resource-state";

const state = (
  content: string,
  type: ResourceState["type"] = "event-flow",
  metadata?: ResourceState["metadata"],
): ResourceState => ({
  content,
  type,
  ...(metadata === undefined ? {} : { metadata }),
});

describe("resource diff", () => {
  it("compares normalized resource metadata", () => {
    expect(
      diffResources(
        state("", "markdown-document", { description: " A ", tags: ["Docs"] }),
        state("", "markdown-document", {
          description: "A",
          tags: ["docs", " Docs "],
        }),
      ).changed,
    ).toBe(false);
    const diff = diffResources(
      state("", "markdown-document"),
      state("", "markdown-document", { description: "A", tags: ["docs"] }),
    );
    expect(diff.metadata.changes).toEqual([
      {
        kind: "added",
        field: "description",
        identity: "description",
        newValue: "A",
      },
      { kind: "added", field: "tag", identity: "docs", newValue: "docs" },
    ]);
  });

  it("matches event names and aggregates relationship changes", () => {
    const base = `event OrderCreated {\n  domain: Orders\n  arbitrary: old\n}\nproducer Orders\nconsumer Billing\nconsumer Analytics\ntopic orders\nOrders publishes OrderCreated to orders\nBilling consumes OrderCreated from orders\nAnalytics consumes OrderCreated from orders`;
    const proposed = `event OrderCreated {\n  domain: Fulfillment\n  arbitrary: new\n}\nproducer Orders\nconsumer Billing\nconsumer Analytics\nconsumer Notifications\ntopic orders\nOrders publishes OrderCreated to orders\nBilling consumes OrderCreated from orders\nAnalytics consumes OrderCreated from orders\nNotifications consumes OrderCreated from orders`;
    const diff = diffResources(state(base), state(proposed));
    expect(diff.content.available).toBe(true);
    expect(diff.content.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "modified",
          entity: "event-metadata",
          identity: "OrderCreated:domain",
        }),
        expect.objectContaining({
          kind: "modified",
          entity: "event-metadata",
          identity: "OrderCreated:arbitrary",
        }),
        expect.objectContaining({
          kind: "added",
          entity: "subscription",
          identity: "OrderCreated|Notifications",
        }),
      ]),
    );
    expect(
      diff.content.changes.filter((change) => change.entity === "subscription"),
    ).toHaveLength(1);
  });

  it("ignores event-flow formatting changes but retains source hunks", () => {
    const base = "event OrderCreated\nproducer Orders";
    const proposed = "\n event OrderCreated\n\n producer Orders\n";
    const diff = diffResources(state(base), state(proposed));
    expect(diff.content.available).toBe(true);
    expect(diff.content.changes).toEqual([]);
    expect(diff.source.changed).toBe(true);
  });

  it("falls back to source diff when DSL parsing fails", () => {
    const diff = diffResources(state("event Good"), state("event {"));
    expect(diff.content.available).toBe(false);
    expect(diff.content.diagnostics.length).toBeGreaterThan(0);
    expect(diff.source.changed).toBe(true);
  });

  it("compares sequence participants and positional interactions", () => {
    const base = "participant A\nparticipant B\nA -> B: one";
    const proposed = "participant A\nparticipant C\nA -> C: two\nA -> C: three";
    const diff = diffResources(
      state(base, "sequence-diagram"),
      state(proposed, "sequence-diagram"),
    );
    expect(diff.content.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "removed",
          entity: "participant",
          identity: "B",
        }),
        expect.objectContaining({
          kind: "added",
          entity: "participant",
          identity: "C",
        }),
        expect.objectContaining({
          kind: "modified",
          entity: "interaction",
          identity: "message:1",
        }),
        expect.objectContaining({
          kind: "added",
          entity: "interaction",
          identity: "message:2",
        }),
      ]),
    );
  });

  it("keeps positional sequence changes addressable in a large diagram", () => {
    const base = [
      "participant A",
      "participant B",
      ...Array.from({ length: 28 }, (_, index) => `A -> B: stage ${index + 1}`),
    ].join("\n");
    const proposed = base
      .replace("stage 24", "canonical 24")
      .replace("stage 28", "");
    const diff = diffResources(
      state(base, "sequence-diagram"),
      state(proposed, "sequence-diagram"),
    );

    expect(diff.content.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "interaction",
          identity: "message:24",
          kind: "modified",
        }),
        expect.objectContaining({ entity: "interaction", identity: "message:28", kind: "modified" }),
      ]),
    );
  });

  it("keeps event-flow additions and removals visible in semantic diff", () => {
    const base = [
      "event OrderCreated",
      "event OrderDeleted",
      "producer Orders",
      "consumer Billing",
      "Orders publishes OrderCreated",
      "Billing consumes OrderDeleted",
    ].join("\n");
    const proposed = base.replace("event OrderDeleted\n", "").replace(
      "Billing consumes OrderDeleted",
      "Billing consumes OrderCreated",
    );
    const diff = diffResources(state(base), state(proposed));

    expect(diff.content.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: "event", identity: "OrderDeleted", kind: "removed" }),
        expect.objectContaining({ entity: "subscription", identity: "OrderDeleted|Billing", kind: "removed" }),
        expect.objectContaining({ entity: "subscription", identity: "OrderCreated|Billing", kind: "added" }),
      ]),
    );
  });

  it("uses deterministic markdown block changes", () => {
    const diff = diffResources(
      state("# One\n\nold", "markdown-document"),
      state("# One\n\nnew", "markdown-document"),
    );
    expect(diff.content.changes).toEqual([
      expect.objectContaining({ entity: "markdown-block", kind: "modified" }),
    ]);
    expect(diff).toEqual(
      diffResources(
        state("# One\n\nold", "markdown-document"),
        state("# One\n\nnew", "markdown-document"),
      ),
    );
  });
});
