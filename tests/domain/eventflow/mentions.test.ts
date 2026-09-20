import { describe, expect, it } from "vitest";
import { collectEventFlowMentions } from "../../../src/domain/eventflow/mentions";
import { analyzeEventFlow } from "../../../src/language/eventflow/parser";

/**
 * The exact spans where an event flow writes a name. The editor bolds these and
 * renames their usages live, so the collector has to agree with the parser about
 * what counts as a name and where it sits — including the broker after `on`.
 */
const SOURCE = [
  "title Order Processing",
  "event OrderCreated {",
  "  version: 2",
  "}",
  "broker Kafka",
  "topic orders on Kafka",
  "producer OrderService",
  "consumer BillingService",
  "service PaymentService",
  "OrderService publishes OrderCreated to orders",
  "BillingService consumes OrderCreated from orders",
  "publish PaymentRequested from PaymentService to orders",
  "consume PaymentRequested by BillingService from orders",
].join("\n");

/** A mention as `context line:column name`, sorted by position. */
function positions(source: string): string[] {
  const { flow } = analyzeEventFlow(source);
  return collectEventFlowMentions(flow, source)
    .map(
      (mention) =>
        `${mention.context} ${mention.range.start.line}:${mention.range.start.column} ${mention.name}`,
    )
    .sort((a, b) => {
      const [, left] = a.split(" ");
      const [, right] = b.split(" ");
      const [ll, lc] = left.split(":").map(Number);
      const [rl, rc] = right.split(":").map(Number);
      return ll - rl || lc - rc;
    });
}

describe("collectEventFlowMentions", () => {
  it("locates declarations and every reference, including the broker after `on`", () => {
    expect(positions(SOURCE)).toEqual([
      "declaration 1:6 OrderCreated",
      "declaration 4:7 Kafka",
      "declaration 5:6 orders",
      "broker 5:16 Kafka",
      "declaration 6:9 OrderService",
      "declaration 7:9 BillingService",
      "declaration 8:8 PaymentService",
      "service 9:0 OrderService",
      "event 9:23 OrderCreated",
      "channel 9:39 orders",
      "service 10:0 BillingService",
      "event 10:24 OrderCreated",
      "channel 10:42 orders",
      "event 11:8 PaymentRequested",
      "service 11:30 PaymentService",
      "channel 11:48 orders",
      "event 12:8 PaymentRequested",
      "service 12:28 BillingService",
      "channel 12:48 orders",
    ]);
  });

  it("keeps the spans exact, so a rewrite replaces only the name", () => {
    const { flow } = analyzeEventFlow(SOURCE);
    const mentions = collectEventFlowMentions(flow, SOURCE);
    const lines = SOURCE.split("\n");
    for (const mention of mentions) {
      const text = lines[mention.range.start.line].slice(
        mention.range.start.column,
        mention.range.end.column,
      );
      expect(text).toBe(mention.name);
    }
  });

  it("never treats an event's metadata value as a reference", () => {
    const source = [
      "event OrderCreated {",
      "  schema: OrderCreated",
      "}",
      "producer OrderService",
      "OrderService publishes OrderCreated",
    ].join("\n");
    const { flow } = analyzeEventFlow(source);
    const mentions = collectEventFlowMentions(flow, source);
    // Only the declaration on line 1 and the edge on line 4 name the event.
    expect(
      mentions.filter((mention) => mention.name === "OrderCreated"),
    ).toHaveLength(2);
    expect(mentions.some((mention) => mention.range.start.line === 1)).toBe(
      false,
    );
  });

  it("has nothing to say about a title", () => {
    const source = "title Order Processing\nbroker Kafka";
    const { flow } = analyzeEventFlow(source);
    const mentions = collectEventFlowMentions(flow, source);
    expect(mentions.map((mention) => mention.name)).toEqual(["Kafka"]);
  });
});
