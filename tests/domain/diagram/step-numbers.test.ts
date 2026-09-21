import { describe, expect, it } from "vitest";
import { messageStepNumbers } from "../../../src/domain/diagram/step-numbers";
import { analyze } from "../../../src/language/analyze";
import { renderDiagramDocument } from "../../../src/renderer/pipeline/diagram-to-svg";

/**
 * The circled step numbers the canvas prints (and `note on N` refers to), keyed
 * by source line. The editor gutter uses the same map, so it must agree with the
 * renderer exactly — that agreement is asserted here rather than assumed.
 */
const SOURCE = [
  "title Checkout",
  "participant CartService",
  "participant PaymentService",
  "participant DB",
  "",
  "CartService ->> PaymentService: Authorize",
  "PaymentService ->> DB: Save",
  "DB -->> PaymentService: OK",
  "alt declined",
  "  PaymentService -->> CartService: Decline",
  "else approved",
  "  PaymentService -->> CartService: Approve",
  "end",
].join("\n");

describe("messageStepNumbers", () => {
  it("numbers messages in source order, fragments included", () => {
    const { ast } = analyze(SOURCE);
    const byLine = [...messageStepNumbers(ast).entries()].sort(
      (a, b) => a[0] - b[0],
    );
    expect(byLine).toEqual([
      [5, 1],
      [6, 2],
      [7, 3],
      [9, 4],
      [11, 5],
    ]);
  });

  it("has nothing to number without a diagram", () => {
    expect(messageStepNumbers(null).size).toBe(0);
  });

  it("agrees with the numbers the renderer prints on the canvas", () => {
    const { ast } = analyze(SOURCE);
    const printed = [
      ...renderDiagramDocument(ast).svg.matchAll(
        /data-sequence-number="(\d+)"/g,
      ),
    ].map((match) => Number(match[1]));
    // The canvas prints 1..n in order.
    expect(printed).toEqual([1, 2, 3, 4, 5]);

    const byStep = [...messageStepNumbers(ast).entries()].sort(
      (a, b) => a[1] - b[1],
    );
    expect(byStep.map(([, step]) => step)).toEqual(printed);
  });
});
