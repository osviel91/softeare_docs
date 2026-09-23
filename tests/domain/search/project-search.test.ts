import { describe, expect, it } from "vitest";
import {
  parseSearchQuery,
  runSearch,
  searchProject,
  type SearchDocument,
} from "../../../src/domain/search/project-search";

const diagram: SearchDocument = {
  kind: "diagram",
  id: "diag-1",
  projectId: "docs",
  projectName: "Docs",
  name: "checkout.seq",
  title: "Checkout",
  content: [
    "title Checkout",
    "participant CheckoutService",
    "participant PaymentService",
    "CheckoutService ->> PaymentService: POST /payments",
  ].join("\n"),
  metadata: {
    description: "Coordinates payment authorization.\nReserves inventory.",
    tags: ["DDD", "payments", "async"],
  },
  facets: { participants: ["CheckoutService", "PaymentService"] },
};

const note: SearchDocument = {
  kind: "note",
  id: "note-1",
  projectId: "docs",
  projectName: "Docs",
  name: "architecture.md",
  title: "Architecture",
  content: [
    "# Architecture",
    "",
    "The PaymentService owns payments.",
    "See the checkout diagram.",
  ].join("\n"),
};

const documents = [diagram, note];

describe("parseSearchQuery", () => {
  it("treats plain words as free text", () => {
    expect(parseSearchQuery("payment flow")).toEqual({ text: "payment flow" });
  });

  it("parses kind, project and participant filters", () => {
    expect(
      parseSearchQuery("payment kind:diagram project:Docs participant:Pay"),
    ).toEqual({
      text: "payment",
      kinds: ["diagram"],
      project: "Docs",
      participant: "Pay",
    });
  });

  it("accepts several kinds", () => {
    expect(parseSearchQuery("a kind:diagram kind:note").kinds).toEqual([
      "diagram",
      "note",
    ]);
  });

  it("leaves an unknown kind as plain text rather than dropping it", () => {
    expect(parseSearchQuery("kind:event")).toEqual({ text: "kind:event" });
  });

  it("ignores a filter with no value", () => {
    expect(parseSearchQuery("project:")).toEqual({ text: "project:" });
  });

  it("returns empty text for an empty query", () => {
    expect(parseSearchQuery("   ")).toEqual({ text: "" });
  });

  it("parses tag and type filters", () => {
    expect(
      parseSearchQuery("tag:DDD tag:payments type:diagram checkout"),
    ).toEqual({
      text: "checkout",
      kinds: ["diagram"],
      tags: ["ddd", "payments"],
    });
  });

  it("leaves unknown and empty filters as plain text", () => {
    expect(parseSearchQuery("type:unknown")).toEqual({ text: "type:unknown" });
    expect(parseSearchQuery("tag:")).toEqual({ text: "tag:" });
  });
});

describe("searchProject", () => {
  it("finds every occurrence with line, column and offset", () => {
    const matches = searchProject(documents, { text: "PaymentService" });
    // Once in the diagram (two: declaration + message) and once in the note.
    expect(matches).toHaveLength(3);
    const [first] = matches;
    expect(first.line).toBe(3);
    expect(first.column).toBe(13);
    expect(first.offset).toBe(
      "title Checkout\nparticipant CheckoutService\nparticipant ".length,
    );
    expect(first.length).toBe("PaymentService".length);
    expect(first.title).toBe("Checkout");
    expect(first.projectName).toBe("Docs");
  });

  it("matches case-insensitively", () => {
    expect(searchProject(documents, { text: "paymentservice" })).toHaveLength(
      3,
    );
  });

  it("matches descriptions, tags, and names without duplicating body hits", () => {
    const [description] = searchProject(documents, { text: "inventory" });
    expect(description.matchedFields).toEqual(["description"]);
    expect(description.excerpt).toBe("Reserves inventory.");

    const [tag] = searchProject(documents, { text: "async" });
    expect(tag.matchedFields).toEqual(["tags"]);

    const [name] = searchProject(documents, { text: "checkout.seq" });
    expect(name.matchedFields).toEqual(["name"]);
  });

  it("uses exact, case-insensitive tag identity for tag filters", () => {
    expect(searchProject(documents, { text: "", tags: ["ddd"] })).toHaveLength(
      1,
    );
    expect(
      searchProject(
        [
          ...documents,
          { ...note, id: "note-2", metadata: { tags: ["dddish"] } },
        ],
        { text: "", tags: ["ddd"] },
      ),
    ).toHaveLength(1);
  });

  it("supports type filters and combines filters with text", () => {
    expect(
      runSearch(documents, "type:diagram payment").every(
        (m) => m.kind === "diagram",
      ),
    ).toBe(true);
    expect(runSearch(documents, "type:note payment")).toHaveLength(2);
    expect(runSearch(documents, "tag:payments tag:async payment")).toHaveLength(
      3,
    );
  });

  it("reports the excerpt as the trimmed matching line", () => {
    const [first] = searchProject(documents, { text: "POST /payments" });
    expect(first.excerpt).toBe(
      "CheckoutService ->> PaymentService: POST /payments",
    );
    expect(first.line).toBe(4);
  });

  it("filters by kind", () => {
    const matches = searchProject(documents, {
      text: "PaymentService",
      kinds: ["note"],
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe("note");
  });

  it("filters by project name", () => {
    expect(
      searchProject(documents, { text: "PaymentService", project: "docs" }),
    ).toHaveLength(3);
    expect(
      searchProject(documents, { text: "PaymentService", project: "other" }),
    ).toHaveLength(0);
  });

  it("filters by participant facet", () => {
    const matches = searchProject(documents, {
      text: "the",
      participant: "Pay",
    });
    expect(matches.every((match) => match.kind === "diagram")).toBe(true);
  });

  it("lists documents for a filter-only query", () => {
    const matches = searchProject(documents, {
      text: "",
      participant: "PaymentService",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("diag-1");
    expect(matches[0].length).toBe(0);
    expect(matches[0].excerpt).toBe("Checkout");
  });

  it("matches nothing for an empty query with no filters", () => {
    expect(searchProject(documents, { text: "" })).toEqual([]);
  });

  it("caps the number of matches", () => {
    const many: SearchDocument = {
      ...diagram,
      id: "diag-2",
      content: Array.from({ length: 20 }, () => "hit").join("\n"),
    };
    expect(searchProject([many], { text: "hit" }, { limit: 5 })).toHaveLength(
      5,
    );
  });

  it("truncates a long excerpt around the match", () => {
    const long: SearchDocument = {
      ...note,
      id: "note-2",
      content: `${"x".repeat(200)} needle ${"y".repeat(200)}`,
    };
    const [match] = searchProject(
      [long],
      { text: "needle" },
      {
        excerptLength: 40,
      },
    );
    expect(match.excerpt.startsWith("…")).toBe(true);
    expect(match.excerpt.endsWith("…")).toBe(true);
    expect(match.excerpt).toContain("needle");
    expect(match.excerpt.length).toBeLessThanOrEqual(42);
  });

  it("reports several hits on one line separately", () => {
    const matches = searchProject([{ ...note, content: "ab ab ab" }], {
      text: "ab",
    });
    expect(matches).toHaveLength(3);
    expect(matches.map((match) => match.column)).toEqual([1, 4, 7]);
  });
});

describe("runSearch", () => {
  it("parses and searches in one step", () => {
    expect(runSearch(documents, "kind:note architecture")).toHaveLength(1);
  });
});
