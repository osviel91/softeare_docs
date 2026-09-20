import { describe, expect, it } from "vitest";
import {
  rankItems,
  type QuickOpenItem,
} from "../../../src/features/quickopen/quick-open-model";

/** A representative browse list, already arranged by group for display. */
const items: QuickOpenItem[] = [
  {
    id: "diagram:pay",
    label: "Payment Processing",
    detail: "payment.seq",
    group: "Diagrams",
    search: "Payment Processing payment.seq",
  },
  {
    id: "document:arch",
    label: "Architecture",
    detail: "architecture.md",
    group: "Documents",
    search: "Architecture architecture.md",
  },
  {
    id: "diagram:pay#participant:svc",
    label: "PaymentService",
    detail: "participant · payment.seq",
    group: "Symbols",
    search: "PaymentService participant · payment.seq",
  },
  {
    id: "document:arch#heading:flow",
    label: "Payment flow",
    detail: "heading · architecture.md",
    group: "Headings",
    search: "Payment flow heading · architecture.md",
  },
];

describe("rankItems", () => {
  it("keeps the browse order for an empty query", () => {
    const ranked = rankItems(items, "");
    expect(ranked.map((entry) => entry.item.id)).toEqual(
      items.map((item) => item.id),
    );
    expect(ranked.every((entry) => entry.positions.length === 0)).toBe(true);
  });

  it("keeps the browse order for a whitespace-only query", () => {
    const ranked = rankItems(items, "   ");
    expect(ranked.map((entry) => entry.item.id)).toEqual(
      items.map((item) => item.id),
    );
  });

  it("lets the ranking win over the group order for a real query", () => {
    const weakFirst: QuickOpenItem[] = [
      {
        id: "document:prepay",
        label: "Prepay Amount",
        detail: "prepay.md",
        group: "Documents",
        search: "Prepay Amount prepay.md",
      },
      {
        id: "diagram:pay",
        label: "Payment Processing",
        detail: "payment.seq",
        group: "Diagrams",
        search: "Payment Processing payment.seq",
      },
    ];
    const ranked = rankItems(weakFirst, "pay");
    expect(ranked.map((entry) => entry.item.id)).toEqual([
      "diagram:pay",
      "document:prepay",
    ]);
  });

  it("matches against label and detail together", () => {
    const ranked = rankItems(items, "participant");
    expect(ranked.map((entry) => entry.item.id)).toEqual([
      "diagram:pay#participant:svc",
    ]);
  });

  it("reports positions into the search key so label indices are usable", () => {
    const ranked = rankItems(items, "payment");
    const first = ranked.find((entry) => entry.item.id === "diagram:pay");
    expect(first).toBeDefined();
    expect(first!.positions).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("reports detail-only matches with positions past the label", () => {
    const symbol: QuickOpenItem = {
      id: "diagram:checkout#participant:db",
      label: "Checkout",
      detail: "symbol · zzq",
      group: "Symbols",
      search: "Checkout symbol · zzq",
    };
    const ranked = rankItems([symbol], "zzq");
    expect(ranked[0].positions).toEqual([18, 19, 20]);
    expect(ranked[0].positions.every((p) => p >= symbol.label.length)).toBe(
      true,
    );
  });

  it("preserves the item itself, not a copy", () => {
    const ranked = rankItems(items, "arch");
    expect(ranked[0].item).toBe(items[1]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(rankItems(items, "zzzz")).toEqual([]);
  });
});
