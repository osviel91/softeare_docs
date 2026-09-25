import { describe, expect, it } from "vitest";
import { parseEventFlow } from "../../src/language/eventflow/parser";
import { projectEventFlowToCausalView, handlerNodeId, type CausalNodeId } from "../../src/domain/eventflow/causal-projection";
import { layoutCausalView } from "../../src/layout/causal-layout";
import { renderCausalToSvg } from "../../src/renderer/svg/causal-svg-renderer";

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
});
