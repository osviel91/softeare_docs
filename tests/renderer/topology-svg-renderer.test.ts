import { describe, expect, it } from "vitest";
import { parseEventFlow } from "../../src/language/eventflow/parser";
import { projectEventFlowToTopology } from "../../src/domain/eventflow/topology-projection";
import { layoutTopology } from "../../src/layout/topology-layout";
import { renderTopologyToSvg } from "../../src/renderer/svg/topology-svg-renderer";

describe("topology self-loops", () => {
  it("renders a self-loop with a readable label beside the loop", () => {
    const flow = parseEventFlow(`
event NegativeLedgerBalanceNotification
service Transactions
Transactions publishes NegativeLedgerBalanceNotification
Transactions consumes NegativeLedgerBalanceNotification
`).flow;
    const layout = layoutTopology(projectEventFlowToTopology(flow));
    const svg = renderTopologyToSvg(layout);
    const edge = new DOMParser().parseFromString(svg, "image/svg+xml").querySelector(".topology-edge");

    expect(edge?.querySelector("path")?.getAttribute("d")).toContain("C");
    expect(Number(edge?.querySelector("text")?.getAttribute("x"))).toBeGreaterThan(
      layout.nodes[0].x + layout.nodes[0].width,
    );
    expect(layout.width).toBeGreaterThan(layout.nodes[0].x + layout.nodes[0].width + 32);
  });
});
