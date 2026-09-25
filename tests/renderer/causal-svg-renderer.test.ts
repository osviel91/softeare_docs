import { describe, expect, it } from "vitest";
import { parseEventFlow } from "../../src/language/eventflow/parser";
import { projectEventFlowToCausalView, handlerNodeId, type CausalNodeId } from "../../src/domain/eventflow/causal-projection";
import { layoutCausalView } from "../../src/layout/causal-layout";
import { renderCausalToSvg } from "../../src/renderer/svg/causal-svg-renderer";
import { estimateTextWidth } from "../../src/layout/text";

function render(source: string, selected?: string) {
  const view = projectEventFlowToCausalView(parseEventFlow(source).flow);
  return renderCausalToSvg(layoutCausalView(view), view, { selected: selected as CausalNodeId | undefined });
}

describe("causal SVG presentation", () => {
  it("distinguishes events, handlers, effects, and causal edge labels", () => {
    const svg = render([
      "event Received", "event Created", "handler TransactionHandler in Transactions",
      "Received handled by TransactionHandler", "TransactionHandler causes Created",
      "effect persist on TransactionHandler kind state: persist transaction",
    ].join("\n"));
    expect(svg).toContain('aria-label="Event: Received"');
    expect(svg).toContain('aria-label="Handler: TransactionHandler"');
    expect(svg).toContain('aria-label="Effect: persist transaction"');
    expect(svg).toContain('aria-label="handled by"');
    expect(svg).toContain('aria-label="causes"');
    expect(svg).toContain('aria-label="effect"');
  });

  it("renders message kind and initiation without color-only semantics", () => {
    const svg = render([
      "event RetryCommand {", "  kind: command", "  provenance: internal", "}",
      "handler RetryHandler", "scheduled initiates RetryCommand",
      "RetryCommand handled by RetryHandler",
    ].join("\n"));
    expect(svg).toContain('aria-label="Command: RetryCommand"');
    expect(svg).toContain("COMMAND · internal · initiated scheduled");
    expect(svg).toContain('data-edge-type="MESSAGE_HANDLED_BY_HANDLER"');
  });

  it("subdues unrelated branches while preserving the selected context", () => {
    const svg = render([
      "event A", "event B", "event C", "handler H1", "handler H2",
      "A handled by H1", "A handled by H2", "H1 causes B", "H2 causes C",
    ].join("\n"), handlerNodeId("H1"));
    expect(svg).toContain('data-causal-id="handler:H1"');
    expect(svg).toContain('class="causal-node is-subdued"');
  });

  it("renders wrapped labels and explicit focus-path classes", () => {
    const source = [
      "event VeryLongMessageNameThatShouldWrapAcrossSeveralLines",
      "event Downstream",
      "handler VeryLongHandlerNameThatShouldWrapToo",
      "VeryLongMessageNameThatShouldWrapAcrossSeveralLines handled by VeryLongHandlerNameThatShouldWrapToo",
      "VeryLongHandlerNameThatShouldWrapToo causes Downstream",
    ].join("\n");
    const svg = render(source, "message:VeryLongMessageNameThatShouldWrapAcrossSeveralLines");
    expect(svg).toContain("<tspan");
    expect(svg).toContain("is-causal-neighbor");
    expect(svg).toContain("is-downstream");
    expect(svg).toContain("data-focus-detail");
    expect(svg).toContain("V");
  });

  it("routes multiple effect edges through separate lanes", () => {
    const svg = render([
      "event Raised", "handler Persistence", "handler Registry",
      "Raised handled by Persistence", "Raised handled by Registry",
      "effect persist on Persistence: persist transaction",
      "effect update on Registry: update registries",
    ].join("\n"));
    const paths = [...svg.matchAll(/data-edge-type="HANDLER_HAS_EFFECT"[^>]*><path d="([^"]+)"/g)];
    const lanes = paths.map((path) => path[1]?.match(/^M[\d.]+ [\d.]+ H([\d.]+)/)?.[1]);

    expect(paths).toHaveLength(2);
    expect(new Set(lanes).size).toBe(2);
  });

  it("wraps production identifiers at semantic boundaries without overflow", () => {
    const labels = [
      "ExportTransactionsProcessEndedEvent",
      "ExportConsumptionProcessEndedEvent",
      "CorporateBalanceExportEndedHandler",
      "ResendNonReceivedWebhookEventsCommand",
    ];
    const source = [
      ...labels.filter((label) => !label.endsWith("Handler")).map((label) => `event ${label}`),
      `handler CorporateBalanceExportEndedHandler`,
      ...labels.filter((label) => label.endsWith("Event")).map((label) => `${label} handled by CorporateBalanceExportEndedHandler`),
    ].join("\n");
    const view = projectEventFlowToCausalView(parseEventFlow(source).flow);
    const layout = layoutCausalView(view);
    const expectedLines: Record<string, string[]> = {
      ExportTransactionsProcessEndedEvent: ["Export Transactions", "Process Ended Event"],
      ExportConsumptionProcessEndedEvent: ["Export Consumption", "Process Ended Event"],
      CorporateBalanceExportEndedHandler: ["Corporate Balance", "Export Ended Handler"],
      ResendNonReceivedWebhookEventsCommand: ["Resend Non Received", "Webhook Events Command"],
    };

    for (const label of labels) {
      const node = layout.nodes.find((item) => item.label === label);
      expect(node).toBeDefined();
      expect(node?.lines).toEqual(expectedLines[label]);
      for (const line of node?.lines ?? []) {
        expect(estimateTextWidth(line) + 24).toBeLessThanOrEqual(node!.box.width);
      }
    }
    expect(layout.nodes.find((node) => node.label === labels[0])?.lines).toEqual([
      "Export Transactions",
      "Process Ended Event",
    ]);
  });
});
