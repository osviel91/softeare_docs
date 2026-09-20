/**
 * Preview pipeline: event-flow source / AST → SVG document string.
 *
 * This is the only place the UI is allowed to reach across the language, layout,
 * and renderer layers. It keeps the UI thin and preserves the hard boundaries:
 * the editor never computes geometry, the renderer never parses text.
 */
import type { EventFlow } from "../../domain/eventflow/ast";
import { layoutEventFlow } from "../../layout/eventflow-layout";
import {
  eventFlowCanvasSize,
  renderEventFlowToSvg,
  type EventFlowRenderOptions,
} from "../../renderer/svg/eventflow-svg-renderer";
import { analyzeEventFlow } from "../../language/eventflow/parser";

/** A document with no statements, used when the caller has no flow at all. */
const EMPTY_FLOW: EventFlow = { statements: [] };

/**
 * Render a parsed AST to an SVG document string, plus the canvas size.
 *
 * The viewport needs the flow's pixel size to center and fit it, and the
 * renderer owns that calculation, so it is returned alongside the markup instead
 * of being parsed back out of it.
 */
export interface EventFlowDocument {
  svg: string;
  width: number;
  height: number;
}

/**
 * Render a parsed AST to an SVG document string.
 *
 * A `null` flow renders as the canonical empty document rather than throwing, so
 * the editor stays usable on malformed or unfinished input (see ADR-003). The
 * layout engine is total on an empty statement list, so there is exactly one
 * definition of "empty canvas": whatever `layoutEventFlow` produces for no
 * statements.
 */
export function renderEventFlowDocument(
  flow: EventFlow | null,
  options: EventFlowRenderOptions = {},
): EventFlowDocument {
  const layout = layoutEventFlow(flow ?? EMPTY_FLOW);
  return {
    svg: renderEventFlowToSvg(layout, options),
    // Padding changes the canvas the SVG is drawn on, so the size reported to
    // the viewport (and to exporters) must use the same padding.
    ...eventFlowCanvasSize(layout, options.padding),
  };
}

/** Render a parsed AST to just its SVG document string. */
export function renderEventFlow(flow: EventFlow | null): string {
  return renderEventFlowDocument(flow).svg;
}

/** Turn event-flow source into an SVG document string. */
export function eventFlowSourceToSvg(source: string): string {
  const { flow } = analyzeEventFlow(source);
  return renderEventFlow(flow);
}
