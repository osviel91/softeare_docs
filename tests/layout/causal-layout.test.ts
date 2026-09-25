import { describe, expect, it } from "vitest";
import { parseEventFlow } from "../../src/language/eventflow/parser";
import { projectEventFlowToCausalView } from "../../src/domain/eventflow/causal-projection";
import { layoutCausalView } from "../../src/layout/causal-layout";

function layout(source: string) {
  return layoutCausalView(projectEventFlowToCausalView(parseEventFlow(source).flow));
}

describe("layoutCausalView", () => {
  it("is deterministic and gives every semantic node unique geometry", () => {
    const source = [
      "event A", "event B", "handler H", "A handled by H", "H causes B",
      "effect save on H kind state: save",
    ].join("\n");
    const first = layout(source);
    expect(first).toEqual(layout(source));
    expect(new Set(first.nodes.map((node) => `${node.box.x}:${node.box.y}`)).size).toBe(first.nodes.length);
  });

  it("keeps cycles finite and disconnected components separated", () => {
    const result = layout([
      "event A", "event B", "event Isolated", "handler H1", "handler H2",
      "A handled by H1", "H1 causes B", "B handled by H2", "H2 causes A",
    ].join("\n"));
    expect(result.nodes).toHaveLength(5);
    expect(result.edges).toHaveLength(4);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it("keeps effects subordinate to their handler instead of ranking them", () => {
    const result = layout([
      "event A", "event B", "handler H", "A handled by H", "H causes B",
      "effect save on H: Save state",
    ].join("\n"));
    const handler = result.nodes.find((node) => node.id === "handler:H")!;
    const effect = result.nodes.find((node) => node.id === "effect:save")!;
    expect(effect.box.y).toBeGreaterThan(handler.box.y + handler.box.height);
    expect(effect.box.x).toBeGreaterThanOrEqual(handler.box.x - effect.box.width);
  });
});
