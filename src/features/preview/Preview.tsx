/**
 * Diagram preview.
 *
 * Renders the SVG produced by the preview pipeline inside {@link DiagramViewport},
 * which owns pan/zoom. Preview never parses source text itself (Rule 1) — it
 * receives DSL source and delegates to {@link useDiagram} plus the pure pipeline
 * helper. When the diagram is invalid it shows an empty canvas and a hint
 * pointing at the diagnostics instead of crashing.
 */
import { useMemo } from "react";
import { isValid } from "../../language/validator/validator";
import { useDiagram } from "./use-diagram";
import { renderDiagramDocument } from "./diagram-to-svg";
import DiagramViewport from "./DiagramViewport";

export interface PreviewProps {
  /** The DSL source to render. */
  source: string;
  /**
   * Whether the canvas tracks the source automatically. When false the viewport
   * keeps showing the diagram rendered last, so a large diagram does not re-lay
   * out on every keystroke.
   */
  autoUpdate?: boolean;
  /** Called when the user asks to render the current source while paused. */
  onRender?: () => void;
  /** True when the source changed since the last render while paused. */
  isStale?: boolean;
}

export default function Preview({
  source,
  autoUpdate = true,
  onRender,
  isStale = false,
}: PreviewProps) {
  const { ast, diagnostics } = useDiagram(source);
  const document = useMemo(() => renderDiagramDocument(ast), [ast]);
  // `isValid` requires a non-null AST, so guard before calling.
  const valid = ast != null && isValid(ast);

  return (
    <div className="preview" data-testid="diagram-preview">
      {valid ? (
        <>
          <DiagramViewport
            svg={document.svg}
            size={{ width: document.width, height: document.height }}
            svgTestId="preview-svg"
          />
          {!autoUpdate && (
            <div className="preview__pause" data-testid="preview-paused">
              <span className="preview__pause-label">
                {isStale ? "Source changed" : "Up to date"}
              </span>
              <button
                type="button"
                className="button button--primary"
                data-testid="render-button"
                onClick={onRender}
                disabled={!isStale}
              >
                Render
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="preview__empty" data-testid="preview-empty">
          Fix {diagnostics.length} issue{diagnostics.length === 1 ? "" : "s"} to
          preview the diagram.
        </p>
      )}
    </div>
  );
}
