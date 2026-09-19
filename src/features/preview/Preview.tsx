/**
 * Diagram preview (Phase 3).
 *
 * Renders the SVG produced by the preview pipeline. It never parses source text
 * itself (Rule 1) — it receives DSL source and delegates to {@link useDiagram}
 * plus the pure pipeline helper. When the diagram is invalid it shows an empty
 * canvas and a hint pointing at the diagnostics instead of crashing. Preview is
 * self-contained: it derives both the diagram and its issue count from its own
 * analysis, so it needs only the source.
 */
import { useMemo } from "react";
import { isValid } from "../../language/validator/validator";
import { useDiagram } from "./use-diagram";
import { renderDiagram } from "./diagram-to-svg";

export interface PreviewProps {
  /** The DSL source to render. */
  source: string;
}

export default function Preview({ source }: PreviewProps) {
  const { ast, diagnostics } = useDiagram(source);
  const svg = useMemo(() => renderDiagram(ast), [ast]);
  // `isValid` requires a non-null AST, so guard before calling.
  const valid = ast != null && isValid(ast);

  return (
    <div className="preview" data-testid="diagram-preview">
      {valid ? (
        <div
          className="preview__svg"
          data-testid="preview-svg"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <p className="preview__empty" data-testid="preview-empty">
          Fix {diagnostics.length} issue{diagnostics.length === 1 ? "" : "s"} to
          preview the diagram.
        </p>
      )}
    </div>
  );
}
