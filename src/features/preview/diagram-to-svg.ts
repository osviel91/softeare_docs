/**
 * Preview pipeline: DSL source / AST → SVG document string.
 *
 * This is the only place the UI is allowed to reach across the language, layout,
 * and renderer layers. It keeps the UI thin and preserves the hard boundaries:
 * the editor never computes geometry, the renderer never parses text.
 */
import type { SequenceDiagram } from "../../domain/diagram/ast";
import {
  MARGIN_X,
  PARTICIPANT_BOX_HEIGHT,
  TITLE_HEIGHT,
  type DiagramLayout,
} from "../../layout/geometry";
import { layoutDiagram } from "../../layout/sequence-layout";
import { renderDiagramToSvg } from "../../renderer/svg/sequence-svg-renderer";
import { analyze } from "../../language/analyze";
import { isValid } from "../../language/validator/validator";

/** An empty-canvas layout: no title, participants, or messages. */
function emptyLayout(): DiagramLayout {
  return {
    width: MARGIN_X * 2,
    height: PARTICIPANT_BOX_HEIGHT + TITLE_HEIGHT,
    participants: [],
    messages: [],
  };
}

/**
 * Render a parsed AST to an SVG document string.
 *
 * Invalid ASTs (for example, duplicate participants that the validator flags
 * but still returns) render as an empty canvas rather than throwing, so the
 * editor stays usable on malformed input (see ADR-003). `layoutDiagram`
 * asserts its preconditions, so validity is re-checked here before laying out.
 */
export function renderDiagram(ast: SequenceDiagram | null): string {
  if (!ast || !isValid(ast)) {
    return renderDiagramToSvg(emptyLayout());
  }
  return renderDiagramToSvg(layoutDiagram(ast));
}

/** Turn DSL source into an SVG document string. */
export function diagramToSvg(source: string): string {
  const { ast } = analyze(source);
  return renderDiagram(ast);
}
