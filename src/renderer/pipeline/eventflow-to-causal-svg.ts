import type { EventFlow } from "../../domain/eventflow/ast";
import { projectEventFlowToCausalView, type CausalNodeId } from "../../domain/eventflow/causal-projection";
import { layoutCausalView } from "../../layout/causal-layout";
import { causalCanvasSize, renderCausalToSvg } from "../svg/causal-svg-renderer";

export function renderEventFlowCausalDocument(flow: EventFlow | null, selected?: CausalNodeId | null) {
  const view = projectEventFlowToCausalView(flow ?? { statements: [] });
  const layout = layoutCausalView(view);
  return { svg: renderCausalToSvg(layout, view, { selected }), ...causalCanvasSize(layout), view };
}
