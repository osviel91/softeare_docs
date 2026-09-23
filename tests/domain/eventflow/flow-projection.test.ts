import { describe, expect, it } from "vitest";
import { parseEventFlow } from "../../../src/language/eventflow/parser";
import { projectEventFlowToFlowView } from "../../../src/domain/eventflow/flow-projection";

function project(source: string) {
  return projectEventFlowToFlowView(parseEventFlow(source).flow);
}

describe("projectEventFlowToFlowView", () => {
  it("projects relationships, metadata, channels, and causal order without geometry", () => {
    const source = `event Second
event First {
  schema: orders.v1
}
broker Kafka
topic orders on Kafka
service OrderService
service BillingService
OrderService publishes First to orders
BillingService consumes First from orders
BillingService publishes Second
`;
    const view = project(source);

    expect(view.rows.map((row) => row.event)).toEqual(["First", "Second"]);
    expect(view.rows[0]).toMatchObject({
      event: "First",
      producer: {
        name: "OrderService",
        channel: { name: "orders", kind: "topic", broker: "Kafka" },
      },
      consumers: [
        { name: "BillingService", channel: { name: "orders", kind: "topic" } },
      ],
    });
    expect(view.rows[0].metadata).toEqual([
      expect.objectContaining({ key: "schema", value: "orders.v1" }),
    ]);
    expect(view.rows.every((row) => !("eventBox" in row))).toBe(true);
  });

  it("keeps the first producer and distinct consumers in source order", () => {
    const view = project(`event E
service A
service B
service C
A publishes E
B publishes E
C consumes E
B consumes E
B consumes E
`);

    expect(view.rows[0].producer?.name).toBe("A");
    expect(view.rows[0].consumers.map((consumer) => consumer.name)).toEqual([
      "C",
      "B",
    ]);
  });

  it("marks cycle rows without adding geometry", () => {
    const view = project(`event Ping
event Pong
service A
service B
A publishes Ping
B consumes Ping
B publishes Pong
A consumes Pong
`);

    expect(view.cyclic).toBe(true);
    expect(view.rows.every((row) => row.cyclic)).toBe(true);
  });
});
