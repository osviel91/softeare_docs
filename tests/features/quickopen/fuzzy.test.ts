import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyRank } from "../../../src/features/quickopen/fuzzy";

describe("fuzzyMatch", () => {
  it("matches a query against a target as a case-insensitive subsequence", () => {
    expect(fuzzyMatch("PAY", "Payment")).not.toBeNull();
    expect(fuzzyMatch("pay", "PAYMENT")).not.toBeNull();
    expect(fuzzyMatch("pay", "Payment")?.positions).toEqual([0, 1, 2]);
  });

  it("reports the index of every matched character", () => {
    expect(fuzzyMatch("ment", "Payment")?.positions).toEqual([3, 4, 5, 6]);
    expect(fuzzyMatch("pat", "Payment")?.positions).toEqual([0, 1, 6]);
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyMatch("xyz", "Payment")).toBeNull();
    expect(fuzzyMatch("payz", "Payment")).toBeNull();
  });

  it("returns null when the matched characters are out of order", () => {
    expect(fuzzyMatch("yap", "Payment")).toBeNull();
  });

  it("treats an empty or whitespace-only query as a zero-score match", () => {
    expect(fuzzyMatch("", "Payment")).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch("   ", "Payment")).toEqual({ score: 0, positions: [] });
  });

  it("scores a prefix above a scattered match", () => {
    const prefix = fuzzyMatch("pay", "Payment");
    const scattered = fuzzyMatch("pay", "Post Apocalyptic Yearly");
    expect(prefix).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(prefix!.score).toBeGreaterThan(scattered!.score);
  });

  it("rewards a match at a word boundary", () => {
    const boundary = fuzzyMatch("id", "node-id");
    const midword = fuzzyMatch("id", "nodeid");
    expect(boundary).not.toBeNull();
    expect(midword).not.toBeNull();
    expect(boundary!.score).toBeGreaterThan(midword!.score);
    expect(fuzzyMatch("id", "nodeId")!.score).toBeGreaterThan(midword!.score);
  });

  it("rewards a match at the very start of the target", () => {
    expect(fuzzyMatch("a", "abc")!.score).toBeGreaterThan(
      fuzzyMatch("a", "bac")!.score,
    );
  });

  it("penalises gaps between matched characters", () => {
    const adjacent = fuzzyMatch("pay", "pay-----------")!;
    const scattered = fuzzyMatch("pay", "p---------a-y---")!;
    expect(adjacent.score).toBeGreaterThan(scattered.score);
  });

  it("ranks a shorter target above an equal-quality longer one", () => {
    const ranked = fuzzyRank(
      ["pay xxxxxxxxxx", "pay x"],
      "pay",
      (item) => item,
    );
    expect(ranked.map((entry) => entry.item)).toEqual([
      "pay x",
      "pay xxxxxxxxxx",
    ]);
  });

  it("matches space-separated tokens in order", () => {
    const match = fuzzyMatch("pay aut", "Payment Authorization");
    expect(match).not.toBeNull();
    expect(match!.positions).toEqual([0, 1, 2, 8, 9, 10]);
  });

  it("still matches when the query tokens are transposed", () => {
    expect(fuzzyMatch("aut pay", "Payment Authorization")).not.toBeNull();
  });

  it("ranks a tight two-token match above a distant one", () => {
    const ranked = fuzzyRank(
      ["Payment Service Authorization", "Payment Authorization"],
      "pay aut",
      (item) => item,
    );
    expect(ranked.map((entry) => entry.item)).toEqual([
      "Payment Authorization",
      "Payment Service Authorization",
    ]);
  });

  it("is deterministic for the same input", () => {
    const items = [
      "Payment Authorization",
      "Payment Service",
      "pay-api",
      "Pay",
    ];
    const first = fuzzyRank(items, "pay", (item) => item);
    const second = fuzzyRank(items, "pay", (item) => item);
    expect(second).toEqual(first);
  });
});

describe("fuzzyRank", () => {
  it("drops items that do not match", () => {
    const ranked = fuzzyRank(["Payment", "Invoice"], "pay", (item) => item);
    expect(ranked.map((entry) => entry.item)).toEqual(["Payment"]);
  });

  it("keeps the input order for an empty query, with score 0", () => {
    const ranked = fuzzyRank(["B", "A", "C"], "", (item) => item);
    expect(ranked.map((entry) => entry.item)).toEqual(["B", "A", "C"]);
    expect(
      ranked.every(
        (entry) => entry.score === 0 && entry.positions.length === 0,
      ),
    ).toBe(true);
  });

  it("keeps the input order for a whitespace-only query", () => {
    const ranked = fuzzyRank(["B", "A"], "  ", (item) => item);
    expect(ranked.map((entry) => entry.item)).toEqual(["B", "A"]);
  });

  it("searches the string returned by key, not the item itself", () => {
    const ranked = fuzzyRank(
      [{ name: "Payment" }, { name: "Invoice" }],
      "pay",
      (item) => item.name,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].item.name).toBe("Payment");
    expect(ranked[0].positions).toEqual([0, 1, 2]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(fuzzyRank(["Payment"], "zzz", (item) => item)).toEqual([]);
  });
});
