import { describe, expect, it } from "vitest";
import {
  completeAt,
  completionLabels,
  type CompletionRequest,
} from "../../../src/domain/project/completion";
import { analyze } from "../../../src/language/analyze";
import type { ProjectSymbol } from "../../../src/domain/project/project-index";

const symbols: ProjectSymbol[] = [
  {
    id: "participant:PaymentService",
    name: "PaymentService",
    kind: "participant",
    resourceId: "d1",
    role: "service",
  },
  {
    id: "participant:PaymentDatabase",
    name: "PaymentDatabase",
    kind: "participant",
    resourceId: "d1",
    role: "database",
  },
  {
    id: "participant:Cart",
    name: "Cart",
    kind: "participant",
    resourceId: "d1",
  },
  {
    id: "diagram:diagram-checkout",
    name: "Checkout",
    kind: "diagram",
    resourceId: "d1",
  },
];

/**
 * Complete at the caret, marked in `marked` with a `|`.
 *
 * A marker rather than "the end of the string" because several cases need the
 * caret inside a fragment, which only parses when its `end` is still there.
 */
function complete(
  marked: string,
  overrides: Partial<CompletionRequest> = {},
): string[] {
  const caret = marked.indexOf("|");
  const source = marked.replace("|", "");
  const offset = caret === -1 ? source.length : caret;
  const { ast } = analyze(source);
  return completionLabels(
    completeAt({
      source,
      offset,
      ast,
      symbols,
      resources: [],
      ...overrides,
    }),
  );
}

describe("completeAt — statement starts", () => {
  it("offers root keywords on an empty line", () => {
    const labels = complete("title T\nparticipant A\n\n");
    expect(labels).toContain("participant");
    expect(labels).toContain("actor");
    expect(labels).toContain("loop");
    expect(labels).toContain("note");
    // A statement keyword is never a fragment branch keyword at the root.
    expect(labels).not.toContain("else");
    expect(labels).not.toContain("end");
  });

  it("filters keywords by the word being typed", () => {
    expect(complete("title T\nparticipant A\nact")).toEqual(["actor"]);
    // Both keywords start with "pa"; the exact-match-first rule puts "par"
    // ahead of the longer "participant".
    expect(complete("title T\nparticipant A\npar")).toEqual([
      "par",
      "participant",
    ]);
    expect(complete("title T\nparticipant A\nzz")).toEqual([]);
  });

  it("offers fragment keywords inside a loop", () => {
    const source =
      "title T\nparticipant A\nparticipant B\nloop retry\n  |\nend";
    const labels = complete(source);
    expect(labels).toContain("end");
    expect(labels).toContain("alt");
    expect(labels).toContain("note");
    expect(labels).toContain("activate");
  });

  it("offers branch keywords after `else`", () => {
    const source =
      "title T\nparticipant A\nalt one\n  A -> A: x\nelse two\n  |\nend";
    const labels = complete(source);
    expect(labels).toContain("end");
    expect(labels).toContain("note");
  });

  it("does not offer nested keywords outside a fragment", () => {
    expect(
      complete("title T\nparticipant A\nparticipant B\nA -> B: x\n"),
    ).not.toContain("end");
  });
});

describe("completeAt — participant positions", () => {
  it("suggests participants after an arrow", () => {
    expect(complete("title T\nparticipant Cart\nCart ->")).toEqual([
      "PaymentService",
      "PaymentDatabase",
      "Cart",
    ]);
  });

  it("suggests and filters after an arrow with a partial word", () => {
    expect(complete("title T\nparticipant Cart\nCart ->> Pay")).toEqual([
      "PaymentService",
      "PaymentDatabase",
    ]);
  });

  it("suggests participants for activate and deactivate", () => {
    expect(
      complete("title T\nparticipant Cart\nCart -> Cart: x\nactivate "),
    ).toEqual(["PaymentService", "PaymentDatabase", "Cart"]);
    expect(
      complete("title T\nparticipant Cart\nCart -> Cart: x\ndeactivate Cart"),
    ).toEqual(["Cart"]);
  });

  it("suggests participants for a note anchor", () => {
    expect(complete("title T\nparticipant Cart\nnote right of Pay|")).toEqual([
      "PaymentService",
      "PaymentDatabase",
    ]);
    expect(complete("title T\nparticipant Cart\nnote over ")).toContain("Cart");
  });

  it("suggests participants as an alias target", () => {
    expect(complete("title T\nparticipant Cart\nalias P = Pay")).toEqual([
      "PaymentService",
      "PaymentDatabase",
    ]);
  });

  it("prefers a prefix match over a contains match", () => {
    const labels = complete("title T\nparticipant Cart\nCart -> P");
    expect(labels[0]).toBe("PaymentService");
    expect(labels).not.toContain("Cart");
  });
});

describe("completeAt — positions with nothing to suggest", () => {
  it("suggests nothing inside a quoted declaration label", () => {
    expect(complete('title T\nparticipant api as "Auth')).toEqual([]);
  });

  it("suggests nothing after a message colon", () => {
    expect(
      complete("title T\nparticipant A\nparticipant B\nA -> B: Pa"),
    ).toEqual([]);
  });

  it("suggests nothing after a note colon", () => {
    expect(complete("title T\nparticipant A\nnote over A: Pa")).toEqual([]);
  });

  it("suggests nothing for an unknown position with no symbols", () => {
    expect(complete("title T\nparticipant A\nA ->", { symbols: [] })).toEqual(
      [],
    );
  });

  it("respects the limit", () => {
    const many: ProjectSymbol[] = Array.from(
      { length: 60 },
      (_unused, index) => ({
        id: `participant:P${index}`,
        name: `Participant${index}`,
        kind: "participant" as const,
        resourceId: "d1",
      }),
    );
    expect(complete("title T\nA ->", { symbols: many, limit: 5 })).toHaveLength(
      5,
    );
  });
});
