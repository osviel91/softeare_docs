import { describe, expect, it } from "vitest";
import { hoverAt } from "../../../src/domain/project/hover";
import { analyze } from "../../../src/language/analyze";

/**
 * Phase B: semantic hover.
 *
 * `hoverAt` is a pure function of the source, its AST and the project index, so
 * it is tested without the editor: the position is resolved through the same
 * node-id lookup the source↔visual sync uses, which is what keeps a hover and a
 * click in agreement about which node is meant.
 */
const SOURCE = [
  "title Checkout",
  "participant CartService",
  'participant PaymentService as "Payments"',
  "",
  "CartService ->> PaymentService: Authorize",
  "note over CartService: Retry twice",
].join("\n");

/** The offset of the first occurrence of `text`, which must be present. */
function offsetOf(text: string): number {
  const at = SOURCE.indexOf(text);
  if (at < 0) throw new Error(`fixture is missing ${text}`);
  return at;
}

describe("hoverAt", () => {
  it("describes a participant, its declaration and its usage count", () => {
    const { ast } = analyze(SOURCE);
    const info = hoverAt({
      source: SOURCE,
      offset: offsetOf("CartService"),
      ast,
      index: null,
      resourceId: "diagram-checkout",
    });
    expect(info?.title).toBe("CartService");
    expect(info?.rows).toContainEqual({ label: "Kind", value: "participant" });
    expect(info?.rows).toContainEqual({
      label: "Declared",
      value: "diagram-checkout:2",
    });
    expect(info?.rows).toContainEqual({
      label: "Used by",
      value: "0 interactions",
    });
  });

  it("shows a declared label when it differs from the id", () => {
    const { ast } = analyze(SOURCE);
    const info = hoverAt({
      source: SOURCE,
      offset: offsetOf("PaymentService"),
      ast,
      index: null,
      resourceId: "diagram-checkout",
    });
    expect(info?.rows).toContainEqual({ label: "Label", value: "Payments" });
  });

  it("describes a message's endpoints, operation and type", () => {
    const { ast } = analyze(SOURCE);
    const info = hoverAt({
      source: SOURCE,
      offset: offsetOf("CartService ->>"),
      ast,
      index: null,
      resourceId: "diagram-checkout",
    });
    expect(info?.title).toBe("CartService → PaymentService");
    expect(info?.rows).toContainEqual({
      label: "Operation",
      value: "Authorize",
    });
    expect(info?.rows).toContainEqual({
      label: "Type",
      value: "synchronous call",
    });
  });

  it("summarises a note", () => {
    const { ast } = analyze(SOURCE);
    const info = hoverAt({
      source: SOURCE,
      offset: offsetOf("note over"),
      ast,
      index: null,
      resourceId: "diagram-checkout",
    });
    expect(info?.title).toBe("Note");
    expect(info?.rows).toContainEqual({ label: "Text", value: "Retry twice" });
  });

  it("says nothing without an AST or for a node with nothing to report", () => {
    const { ast } = analyze(SOURCE);
    expect(
      hoverAt({
        source: SOURCE,
        offset: 0,
        ast: null,
        index: null,
        resourceId: null,
      }),
    ).toBeNull();
    // The title is addressable, but "what is this?" has no answer for it.
    expect(
      hoverAt({
        source: SOURCE,
        offset: offsetOf("title"),
        ast,
        index: null,
        resourceId: null,
      }),
    ).toBeNull();
  });
});
