import { describe, expect, it } from "vitest";
import { parseEventFlow } from "../../../src/language/eventflow/parser";
import { projectEventFlowToCatalog } from "../../../src/domain/eventflow/catalog-projection";

function project(source: string) {
  return projectEventFlowToCatalog(parseEventFlow(source).flow);
}

describe("projectEventFlowToCatalog", () => {
  it("keeps declaration/first-appearance order and all source relationships", () => {
    const view = project(`A publishes Later
event First {
  schema: orders.v1
  custom: retained
}
event Later
topic orders
B consumes Later from orders
A publishes Later to orders
`);

    expect(view.events.map((event) => event.name)).toEqual(["First", "Later"]);
    expect(view.events[0].metadata.map((entry) => entry.key)).toEqual([
      "schema",
      "custom",
    ]);
    expect(view.events[1].publications.map((entry) => entry.producer)).toEqual([
      "A",
      "A",
    ]);
    expect(view.events[1].subscriptions[0]).toMatchObject({
      consumer: "B",
      channel: { name: "orders", kind: "topic" },
    });
  });

  it("handles empty and partial flows", () => {
    expect(project("").events).toEqual([]);
    expect(project("event Orphan").events[0]).toMatchObject({
      name: "Orphan",
      publications: [],
      subscriptions: [],
    });
  });
});
