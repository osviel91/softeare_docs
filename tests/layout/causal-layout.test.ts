import { describe, expect, it } from "vitest";
import { parseEventFlow } from "../../src/language/eventflow/parser";
import { projectEventFlowToCausalView } from "../../src/domain/eventflow/causal-projection";
import { layoutCausalView } from "../../src/layout/causal-layout";

function layout(source: string) {
  return layoutCausalView(projectEventFlowToCausalView(parseEventFlow(source).flow));
}

describe("layoutCausalView", () => {
  function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }

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

  it.each([
    ["UpOne fan-out", ["event Raised", "event SaveCommand", "event AddAccountCommand", "event AddCorporateAccountCommand", "handler Transactions", "handler Accounts", "Raised handled by Transactions", "Raised handled by Accounts", "Transactions causes SaveCommand", "Accounts causes AddAccountCommand", "Accounts causes AddCorporateAccountCommand", "effect save on Transactions: save transaction", "effect account on Accounts: update account"]],
    ["negative balance", ["event Created", "event ThresholdExceeded", "event SendEmailCommand {", "  kind: command", "}", "handler Criteria", "handler Notification", "Created handled by Criteria", "Criteria causes ThresholdExceeded", "ThresholdExceeded handled by Notification", "Notification causes SendEmailCommand", "effect ledger on Criteria: read ledger", "effect mail on Notification: send email"]],
    ["export fan-in", ["event A", "event B", "event C", "event Complete", "handler HA", "handler HB", "handler HC", "A handled by HA", "B handled by HB", "C handled by HC", "HA causes Complete", "HB causes Complete", "HC causes Complete"]],
    ["webhook retry", ["event RetryCommand {", "  kind: command", "  provenance: internal", "}", "event Retried", "handler Retry", "scheduled initiates RetryCommand", "RetryCommand handled by Retry", "Retry causes Retried", "effect find on Retry: find entries", "effect mark on Retry: mark retry success or failure"]],
  ])("keeps %s readable as a general graph", (_name, lines) => {
    const result = layout(lines.join("\n"));
    for (let left = 0; left < result.nodes.length; left++) {
      for (let right = left + 1; right < result.nodes.length; right++) {
        expect(overlaps(result.nodes[left].box, result.nodes[right].box)).toBe(false);
      }
    }
    expect(result.nodes.every((node) => node.lines.length > 0)).toBe(true);
    expect(result.edges.every((edge) => result.nodes.some((node) => node.id === edge.edge.from) && result.nodes.some((node) => node.id === edge.edge.to))).toBe(true);
  });

  it("wraps long labels within bounded node geometry", () => {
    const result = layout([
      "event VeryLongMessageNameThatShouldWrapAcrossSeveralLines",
      "handler VeryLongHandlerNameThatShouldWrapToo",
      "VeryLongMessageNameThatShouldWrapAcrossSeveralLines handled by VeryLongHandlerNameThatShouldWrapToo",
    ].join("\n"));
    expect(result.nodes.some((node) => node.lines.length > 1)).toBe(true);
    expect(Math.max(...result.nodes.map((node) => node.box.width))).toBeLessThanOrEqual(260);
  });

  it("groups several effects under their owning handler", () => {
    const result = layout([
      "event Raised", "handler Accounts", "Raised handled by Accounts",
      "effect save on Accounts: save transaction",
      "effect account on Accounts: update account",
      "effect audit on Accounts: write a very long audit record label that wraps",
      "effect notify on Accounts: notify downstream system",
    ].join("\n"));
    const handler = result.nodes.find((node) => node.id === "handler:Accounts")!;
    const group = result.effectGroups.find((entry) => entry.handlerId === handler.id)!;
    expect(group.effectIds).toHaveLength(4);
    for (const id of group.effectIds) {
      const effect = result.nodes.find((node) => node.id === id)!;
      expect(effect.box.y).toBeGreaterThan(handler.box.y + handler.box.height);
    }
    const effectEdges = result.edges.filter(({ edge }) => edge.type === "HANDLER_HAS_EFFECT");
    expect(effectEdges).toHaveLength(4);
    expect(new Set(effectEdges.map(({ edge }) => edge.from)).size).toBe(1);
  });

  it("keeps multiple handler effect groups separate", () => {
    const result = layout([
      "event Raised", "handler A", "handler B", "Raised handled by A", "Raised handled by B",
      "effect a1 on A: first", "effect a2 on A: second", "effect b1 on B: first", "effect b2 on B: second",
    ].join("\n"));
    expect(result.effectGroups.map((group) => group.effectIds.length)).toEqual([2, 2]);
    for (let left = 0; left < result.nodes.length; left++) {
      for (let right = left + 1; right < result.nodes.length; right++) {
        expect(overlaps(result.nodes[left].box, result.nodes[right].box)).toBe(false);
      }
    }
  });
});
