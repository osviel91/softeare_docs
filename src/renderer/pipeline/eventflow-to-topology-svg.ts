import type { EventFlow } from "../../domain/eventflow/ast";
import { projectEventFlowToTopology } from "../../domain/eventflow/topology-projection";
import { layoutTopology } from "../../layout/topology-layout";
import {
  renderTopologyToSvg,
  topologyCanvasSize,
  type TopologyRenderOptions,
} from "../svg/topology-svg-renderer";

export interface TopologyDocument {
  svg: string;
  width: number;
  height: number;
}

export function renderEventFlowTopologyDocument(
  flow: EventFlow | null,
  options: TopologyRenderOptions = {},
): TopologyDocument {
  const layout = layoutTopology(
    projectEventFlowToTopology(flow ?? { statements: [] }),
  );
  return {
    svg: renderTopologyToSvg(layout, options),
    ...topologyCanvasSize(layout, options.padding),
  };
}
