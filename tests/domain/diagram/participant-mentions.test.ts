import { describe, expect, it } from "vitest";
import {
  collectParticipantMentions,
  participantUsagesOf,
  type ParticipantMention,
} from "../../../src/domain/diagram/participant-mentions";
import { analyze } from "../../../src/language/analyze";

/**
 * The exact spans where a participant name is written. The editor's bold names,
 * its live rename and the project index all read this, so its idea of "where the
 * name is" has to be precise: the identifier token, never the prose in a label.
 */
const SOURCE = [
  "title Checkout",
  "participant CartService",
  'actor User as "Shopper"',
  "alias C = CartService",
  "",
  "User ->> CartService: ask CartService",
  "CartService ->> CartService: self",
  "activate CartService",
  "note over User: User waits",
].join("\n");

/** A mention as `context line:start-end text`, for a readable assertion. */
function describeMention(mention: ParticipantMention): string {
  const line = SOURCE.split("\n")[mention.range.start.line];
  const text = line.slice(mention.range.start.column, mention.range.end.column);
  return `${mention.context} ${mention.range.start.line}:${mention.range.start.column}-${mention.range.end.column} ${text}`;
}

describe("collectParticipantMentions", () => {
  it("locates declarations and every usage, in source order", () => {
    const { ast } = analyze(SOURCE);
    const mentions = collectParticipantMentions(ast!, SOURCE);
    expect(mentions.map(describeMention)).toEqual([
      "declaration 1:12-23 CartService",
      "declaration 2:6-10 User",
      "message 5:0-4 User",
      "message 5:9-20 CartService",
      "message 6:0-11 CartService",
      "message 6:16-27 CartService",
      "activation 7:9-20 CartService",
      "note 8:10-14 User",
      "alias 3:10-21 CartService",
    ]);
  });

  it("never marks the prose after a `:` as an endpoint", () => {
    const { ast } = analyze(SOURCE);
    const mentions = collectParticipantMentions(ast!, SOURCE);
    // `ask CartService` and `User waits` are labels, not references.
    expect(
      mentions.some(
        (mention) =>
          mention.range.start.line === 5 && mention.range.start.column > 20,
      ),
    ).toBe(false);
    expect(
      mentions.some(
        (mention) =>
          mention.range.start.line === 8 && mention.range.start.column > 14,
      ),
    ).toBe(false);
  });

  it("matches whole words, so `Payment` is not found inside `PaymentService`", () => {
    const source = "participant PaymentService\nPayment -> PaymentService: x\n";
    const { ast } = analyze(source);
    const mentions = collectParticipantMentions(ast!, source);
    // The message names an undeclared `Payment`; only its own token is a mention.
    const paymentMentions = mentions.filter(
      (mention) => mention.name === "Payment",
    );
    expect(paymentMentions).toHaveLength(1);
    expect(paymentMentions[0].range).toEqual({
      start: { line: 1, column: 0 },
      end: { line: 1, column: 7 },
    });
  });

  it("gives one span per occurrence of a repeated name", () => {
    const source = "participant A\nA -> A: self\n";
    const { ast } = analyze(source);
    const mentions = collectParticipantMentions(ast!, source);
    // Declaration plus both endpoints of the self-message.
    expect(mentions).toHaveLength(3);
    expect(mentions.map((mention) => mention.range.start.column)).toEqual([
      12, 0, 5,
    ]);
  });

  it("separates usages from the declaration", () => {
    const { ast } = analyze(SOURCE);
    const usages = participantUsagesOf(ast!, SOURCE);
    expect(
      [...new Set(usages.map((mention) => mention.context))].sort(),
    ).toEqual(["activation", "alias", "message", "note"]);
    expect(usages).toHaveLength(7);
  });
});
