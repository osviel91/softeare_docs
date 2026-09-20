import { describe, expect, it } from "vitest";
import type { EventFlow } from "../../src/domain/eventflow/ast";
import { nodeIdOf } from "../../src/domain/diagram/node-id";
import {
  EVENT_BOX_HEIGHT,
  EVENT_CONSUMER_BOX_HEIGHT,
  EVENT_CONSUMER_GAP,
  EVENT_MARGIN_X,
  EVENT_MARGIN_Y,
  EVENT_ROW_GAP,
  EVENT_TITLE_HEIGHT,
  UNKNOWN_CHANNEL_KIND,
  layoutEventFlow,
} from "../../src/layout/eventflow-layout";
import { parseEventFlow } from "../../src/language/eventflow/parser";

/** Parse source into the flow the layout engine consumes. */
function flowFrom(source: string): EventFlow {
  return parseEventFlow(source).flow;
}

const THREE_STEP_CHAIN = `event Third
event Second
event First
service S1
service S2
service S3
S1 publishes First
S2 consumes First
S2 publishes Second
S3 consumes Second
S3 publishes Third
`;

const FAN_OUT = `event OrderCreated
broker Kafka
topic orders on Kafka
queue billing
producer OrderService
consumer BillingService
consumer InventoryService
consumer NotifyService
OrderService publishes OrderCreated to orders
BillingService consumes OrderCreated from orders
InventoryService consumes OrderCreated from orders
NotifyService consumes OrderCreated from orders
`;

const CYCLE = `event Ping
event Pong
service A
service B
A publishes Ping
B consumes Ping
B publishes Pong
A consumes Pong
`;

/** The same event declared, published and consumed more than once. */
const DUPLICATED = `event OrderCreated
event OrderCreated
service A
service B
service C
A publishes OrderCreated
A publishes OrderCreated
C consumes OrderCreated
B consumes OrderCreated
B consumes OrderCreated
`;

describe("layoutEventFlow — one row per event name", () => {
  it("collapses duplicate declarations, publications and subscriptions", () => {
    const layout = layoutEventFlow(flowFrom(DUPLICATED));
    expect(layout.rows).toHaveLength(1);

    const row = layout.rows[0];
    expect(row.event).toBe("OrderCreated");
    // The first publication is the producer, and every consumer appears once.
    expect(row.producer?.name).toBe("A");
    expect(row.consumers.map((consumer) => consumer.name)).toEqual(["C", "B"]);
    expect(row.declaredOnly).toBe(false);
  });

  it("keeps one row per name even when two services publish it", () => {
    const source = `event E
service A
service B
service C
A publishes E
B publishes E
C consumes E
`;
    const layout = layoutEventFlow(flowFrom(source));
    expect(layout.rows).toHaveLength(1);
    expect(layout.rows[0].producer?.name).toBe("A");
  });
});

describe("layoutEventFlow — fan-out", () => {
  it("produces one consumer entry and one box per consumer", () => {
    const layout = layoutEventFlow(flowFrom(FAN_OUT));
    const row = layout.rows[0];
    expect(row.consumers.map((consumer) => consumer.name)).toEqual([
      "BillingService",
      "InventoryService",
      "NotifyService",
    ]);
    expect(row.consumerBoxes).toHaveLength(3);
  });

  it("grows the row so the consumer stack never overlaps", () => {
    const layout = layoutEventFlow(flowFrom(FAN_OUT));
    const row = layout.rows[0];
    const stackHeight = 3 * EVENT_CONSUMER_BOX_HEIGHT + 2 * EVENT_CONSUMER_GAP;
    expect(row.height).toBe(Math.max(EVENT_BOX_HEIGHT, stackHeight));

    row.consumerBoxes.forEach((box, index) => {
      if (index === 0) return;
      const previous = row.consumerBoxes[index - 1];
      expect(box.y - (previous.y + previous.height)).toBe(EVENT_CONSUMER_GAP);
    });
  });

  it("centers the event box on the row and keeps it inside the row", () => {
    const layout = layoutEventFlow(flowFrom(FAN_OUT));
    const row = layout.rows[0];
    const center = row.y + row.height / 2;
    expect(row.eventBox.y + row.eventBox.height / 2).toBeCloseTo(center);
    expect(row.y).toBeLessThanOrEqual(row.eventBox.y);
    expect(row.y + row.height).toBeGreaterThanOrEqual(
      row.eventBox.y + row.eventBox.height,
    );
  });

  it("records the declared channel kind on the producer and consumers", () => {
    const layout = layoutEventFlow(flowFrom(FAN_OUT));
    const row = layout.rows[0];
    expect(row.producer?.channel).toMatchObject({
      name: "orders",
      kind: "topic",
    });
    expect(row.consumers[0].channel).toMatchObject({
      name: "orders",
      kind: "topic",
    });
  });

  it("marks an undeclared channel with the neutral kind", () => {
    const source = `event E
service P
service C
P publishes E to missing
C consumes E from missing
`;
    const layout = layoutEventFlow(flowFrom(source));
    expect(layout.rows[0].producer?.channel?.kind).toBe(UNKNOWN_CHANNEL_KIND);
  });
});

describe("layoutEventFlow — declared but unproduced", () => {
  const DECLARED_ONLY = `event Lonely
event Orphan
event Published
service P
service C
P publishes Published
C consumes Orphan
`;

  it("gives a declared-only event no producer and declaredOnly true", () => {
    const layout = layoutEventFlow(flowFrom(DECLARED_ONLY));
    const lonely = layout.rows.find((row) => row.event === "Lonely");
    expect(lonely?.producer).toBeNull();
    expect(lonely?.declaredOnly).toBe(true);
    expect(lonely?.producerBox).toBeNull();
  });

  it("still lays out an event that appears only in a subscription", () => {
    const layout = layoutEventFlow(flowFrom(DECLARED_ONLY));
    const orphan = layout.rows.find((row) => row.event === "Orphan");
    expect(orphan).toBeDefined();
    expect(orphan?.producer).toBeNull();
    expect(orphan?.declaredOnly).toBe(true);
    expect(orphan?.consumers.map((consumer) => consumer.name)).toEqual(["C"]);
  });
});

describe("layoutEventFlow — causal order", () => {
  it("orders a three-step chain by causality, not declaration order", () => {
    const layout = layoutEventFlow(flowFrom(THREE_STEP_CHAIN));
    // Declared Third, Second, First; consumed-first order must win.
    expect(layout.rows.map((row) => row.event)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(layout.cyclic).toBe(false);
  });

  it("stacks rows top to bottom with no overlap", () => {
    const layout = layoutEventFlow(flowFrom(THREE_STEP_CHAIN));
    layout.rows.forEach((row, index) => {
      if (index === 0) return;
      const previous = layout.rows[index - 1];
      expect(row.y).toBe(previous.y + previous.height + EVENT_ROW_GAP);
    });
  });

  it("keeps written order for events with no causal relationship", () => {
    const source = `event Zeta
event Alpha
event Mu
service S
S publishes Zeta
S publishes Alpha
S publishes Mu
`;
    const layout = layoutEventFlow(flowFrom(source));
    expect(layout.rows.map((row) => row.event)).toEqual([
      "Zeta",
      "Alpha",
      "Mu",
    ]);
  });

  it("orders by the service that both consumes and publishes", () => {
    const source = `event Second
event First
service A
service B
A publishes First
B publishes Second
B consumes First
`;
    // B consumes First and publishes Second, so First → Second and the causal
    // order beats the written one.
    const layout = layoutEventFlow(flowFrom(source));
    expect(layout.rows.map((row) => row.event)).toEqual(["First", "Second"]);
    expect(layout.cyclic).toBe(false);
  });
});

describe("layoutEventFlow — cycles", () => {
  it("sets cyclic and still lays out every event", () => {
    const layout = layoutEventFlow(flowFrom(CYCLE));
    expect(layout.cyclic).toBe(true);
    expect(layout.rows.map((row) => row.event).sort()).toEqual([
      "Ping",
      "Pong",
    ]);
    // Both events are in the cycle, so both rows carry the marker.
    expect(layout.rows.every((row) => row.cyclic === true)).toBe(true);
  });

  it("keeps the remaining events in declaration order after breaking a cycle", () => {
    const layout = layoutEventFlow(flowFrom(CYCLE));
    expect(layout.rows.map((row) => row.event)).toEqual(["Ping", "Pong"]);
  });

  it("marks only the rows the cycle prevented from ordering", () => {
    const source = `event Free
event Ping
event Pong
service F
service A
service B
F publishes Free
A publishes Ping
B consumes Ping
B publishes Pong
A consumes Pong
`;
    // Ping ↔ Pong is a cycle; Free is independent and sorts first.
    const layout = layoutEventFlow(flowFrom(source));
    expect(layout.cyclic).toBe(true);
    expect(layout.rows.map((row) => row.event)).toEqual([
      "Free",
      "Ping",
      "Pong",
    ]);
    expect(layout.rows[0].cyclic).toBe(false);
    expect(layout.rows.slice(1).every((row) => row.cyclic === true)).toBe(true);
  });
});

describe("layoutEventFlow — node ids", () => {
  it("points the event row at its declaration's node id", () => {
    const flow = flowFrom(FAN_OUT);
    const layout = layoutEventFlow(flow);
    const declaration = flow.statements.find(
      (statement) => statement.type === "event",
    );
    expect(declaration?.type).toBe("event");
    if (declaration?.type !== "event") throw new Error("no event declaration");
    expect(layout.rows[0].eventNodeId).toBe(
      nodeIdOf("event", declaration.range),
    );
  });

  it("points producers and consumers at their edge statements", () => {
    const flow = flowFrom(FAN_OUT);
    const layout = layoutEventFlow(flow);
    const row = layout.rows[0];
    const publication = flow.statements.find(
      (statement) => statement.type === "publication",
    );
    const subscription = flow.statements.find(
      (statement) => statement.type === "subscription",
    );
    if (publication?.type !== "publication") {
      throw new Error("no publication");
    }
    if (subscription?.type !== "subscription") {
      throw new Error("no subscription");
    }
    expect(row.producer?.nodeId).toBe(
      nodeIdOf("publication", publication.range),
    );
    expect(row.consumers[0].nodeId).toBe(
      nodeIdOf("subscription", subscription.range),
    );
  });

  it("falls back to the mentioning line for an undeclared event", () => {
    const source = `service C
C consumes Ghost
`;
    const flow = flowFrom(source);
    const layout = layoutEventFlow(flow);
    const subscription = flow.statements.find(
      (statement) => statement.type === "subscription",
    );
    if (subscription?.type !== "subscription") {
      throw new Error("no subscription");
    }
    expect(layout.rows[0].eventNodeId).toBe(
      nodeIdOf("subscription", subscription.range),
    );
  });
});

describe("layoutEventFlow — canvas", () => {
  it("produces an empty layout with a sane size for no statements", () => {
    const layout = layoutEventFlow({ statements: [] });
    expect(layout.rows).toEqual([]);
    expect(layout.cyclic).toBe(false);
    expect(layout.width).toBe(EVENT_MARGIN_X * 2);
    expect(layout.height).toBe(EVENT_MARGIN_Y * 2);
    expect(layout.title).toBeUndefined();
  });

  it("reserves title height when a title is present", () => {
    const flow = flowFrom(`title Report
event E
service S
S publishes E
`);
    const untitled = layoutEventFlow(
      flowFrom(`event E
service S
S publishes E
`),
    );
    const layout = layoutEventFlow(flow);
    expect(layout.title).toBe("Report");
    expect(layout.height - untitled.height).toBe(EVENT_TITLE_HEIGHT);
    expect(layout.rows[0].y).toBe(EVENT_TITLE_HEIGHT + EVENT_MARGIN_Y);
  });

  it("widens the canvas for a wider consumer name", () => {
    const narrow = layoutEventFlow(
      flowFrom(`event E
service P
service C
P publishes E
C consumes E
`),
    );
    const wide = layoutEventFlow(
      flowFrom(`event E
service P
service SomeVeryLongConsumerServiceName
P publishes E
SomeVeryLongConsumerServiceName consumes E
`),
    );
    expect(wide.width).toBeGreaterThan(narrow.width);
  });

  it("fits every row inside the reported width and height", () => {
    const layout = layoutEventFlow(flowFrom(FAN_OUT));
    for (const row of layout.rows) {
      expect(
        row.eventBox.x + row.eventBox.width + EVENT_MARGIN_X,
      ).toBeLessThanOrEqual(layout.width);
      expect(row.y + row.height + EVENT_MARGIN_Y).toBeLessThanOrEqual(
        layout.height,
      );
      for (const box of row.consumerBoxes) {
        expect(box.x + box.width + EVENT_MARGIN_X).toBeLessThanOrEqual(
          layout.width,
        );
      }
    }
  });
});

describe("layoutEventFlow — determinism", () => {
  it("produces deep-equal layouts for the same source", () => {
    const first = layoutEventFlow(flowFrom(FAN_OUT));
    const second = layoutEventFlow(flowFrom(FAN_OUT));
    expect(first).toEqual(second);
  });

  it("produces the same layout from the same AST twice", () => {
    const flow = flowFrom(CYCLE);
    expect(layoutEventFlow(flow)).toEqual(layoutEventFlow(flow));
  });
});
