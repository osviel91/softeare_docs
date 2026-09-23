import { describe, expect, it } from "vitest";
import { parseEventFlow } from "../../../src/language/eventflow/parser";
import { projectEventFlowToTopology } from "../../../src/domain/eventflow/topology-projection";
import { layoutTopology } from "../../../src/layout/topology-layout";

function project(source: string) {
  return projectEventFlowToTopology(parseEventFlow(source).flow);
}

describe("projectEventFlowToTopology", () => {
  it("aggregates mediated event relationships and keeps transport context", () => {
    const topology = project(`
event Created
event Updated
broker Kafka
topic orders on Kafka
service Orders
service Billing
Orders publishes Created to orders
Orders publishes Updated to orders
Billing consumes Created from orders
Billing consumes Updated from orders
`);

    expect(topology.services.map((service) => service.name)).toEqual([
      "Orders",
      "Billing",
    ]);
    expect(topology.connections).toHaveLength(1);
    expect(topology.connections[0]).toMatchObject({
      producer: "Orders",
      consumer: "Billing",
      events: [
        { name: "Created", channels: [{ name: "orders", broker: "Kafka" }] },
        { name: "Updated", channels: [{ name: "orders", broker: "Kafka" }] },
      ],
    });
    expect(topology.connections[0].sourceNodeIds).toHaveLength(4);
  });

  it("preserves disconnected and incomplete services without inventing edges", () => {
    const topology = project(`event Lonely
service A
service B
A publishes Lonely
service C
`);
    expect(topology.services.map((service) => service.name)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(topology.connections).toEqual([]);
  });

  it("keeps event annotations in relationship details, not graph geometry", () => {
    const topology = project(`event Created {
  description: Emitted after persistence.
  domain: Orders
}
service Orders
service Billing
Orders publishes Created
Billing consumes Created
`);
    expect(topology.connections[0].events[0]).toMatchObject({
      name: "Created",
      description: "Emitted after persistence.",
      metadata: [
        { key: "description", value: "Emitted after persistence." },
        { key: "domain", value: "Orders" },
      ],
    });
    expect(layoutTopology(topology).nodes).toHaveLength(2);
  });

  it("is deterministic for cycles and repeated relationships", () => {
    const source = `event Ping
event Pong
service A
service B
A publishes Ping
B consumes Ping
B publishes Pong
A consumes Pong
`;
    const first = project(source);
    const second = project(source);
    expect(first).toEqual(second);
    const layout = layoutTopology(first);
    expect(layout.nodes.map((node) => [node.name, node.x, node.y])).toEqual(
      layoutTopology(second).nodes.map((node) => [node.name, node.x, node.y]),
    );
    expect(layout.nodes).toHaveLength(2);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });
});
