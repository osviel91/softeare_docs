/**
 * Diagram preview.
 *
 * Renders the SVG produced by the preview pipeline inside {@link DiagramViewport},
 * which owns pan/zoom. Preview never parses source text itself (Rule 1) — it
 * receives DSL source and delegates to {@link useDiagram} plus the pure pipeline
 * helper. When the diagram is invalid it shows an empty canvas and a hint
 * pointing at the diagnostics instead of crashing.
 *
 * Notes are attached to their element as a small bullet. Preview owns which
 * bullets are expanded; the toggle is applied when the SVG is built rather than
 * by mutating the DOM, so the rendered markup stays a pure function of the AST
 * plus the expanded set. Expanding a note never changes the canvas size, so the
 * viewport's pan/zoom is untouched.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { isValid } from "../../language/validator/validator";
import { useDiagram } from "./use-diagram";
import { renderDiagramDocument } from "../../renderer/pipeline/diagram-to-svg";
import DiagramViewport from "./DiagramViewport";
import type { DiagramViewportTransform } from "./DiagramViewport";
import type { SemanticChange } from "../../domain/diff/resource-diff";
import { decorateReviewSvg } from "../proposals/review-decorations";

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
  /** Called with a node id when the user clicks the element it represents. */
  onNodeSelect?: (nodeId: string) => void;
  onSemanticMessageSelect?: (messageId: string, nodeId: string | null) => void;
  onSemanticOccurrenceSelect?: (name: string, nodeId: string | null) => void;
  /** The node to highlight, following the editor's caret. */
  activeNodeId?: string | null;
  activeSemanticMessageId?: string | null;
  /** Whether the preview is the only visible app pane. */
  maximized?: boolean;
  /** Toggles the preview-only app layout. */
  onToggleMaximize?: () => void;
  reviewChanges?: SemanticChange[];
  reviewMode?: boolean;
  linkedTransform?: DiagramViewportTransform | null;
  onTransformChange?: (transform: DiagramViewportTransform) => void;
  activeReviewChange?: string | null;
  focusReviewChange?: string | null;
  reviewSide?: "base" | "proposed";
}

export default function Preview({
  source,
  autoUpdate = true,
  onRender,
  isStale = false,
  onNodeSelect,
  onSemanticMessageSelect,
  onSemanticOccurrenceSelect,
  activeNodeId = null,
  activeSemanticMessageId = null,
  maximized = false,
  onToggleMaximize,
  reviewChanges = [],
  reviewMode = false,
  linkedTransform = null,
  onTransformChange,
  activeReviewChange = null,
  focusReviewChange = null,
  reviewSide = "proposed",
}: PreviewProps) {
  const { ast, diagnostics } = useDiagram(source);
  // Which note bullets are expanded. The set resets whenever the source changes
  // so indices can never point at a note that no longer exists.
  const [expandedNotes, setExpandedNotes] = useState<ReadonlySet<number>>(
    () => new Set(),
  );

  useEffect(() => {
    setExpandedNotes((current) => (current.size === 0 ? current : new Set()));
  }, [source]);

  const document = useMemo(
    () => renderDiagramDocument(ast, { expandedNotes }),
    [ast, expandedNotes],
  );
  const reviewSvg = useMemo(
    () => decorateReviewSvg(document.svg, "sequence", reviewChanges, reviewSide),
    [document.svg, reviewChanges, reviewSide],
  );
  // `isValid` requires a non-null AST, so guard before calling.
  const valid = ast != null && isValid(ast);
  const noteCount = ast?.notes.length ?? 0;

  /** Expand or collapse one note, keyed by its index in the AST. */
  const toggleNote = useCallback((index: number): void => {
    setExpandedNotes((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const setAllNotes = useCallback(
    (expand: boolean): void => {
      setExpandedNotes(() => {
        if (!expand) return new Set();
        return new Set(Array.from({ length: noteCount }, (_, index) => index));
      });
    },
    [noteCount],
  );

  return (
    <div className="preview" data-testid="diagram-preview">
      {valid ? (
        <>
          {noteCount > 0 && (
            <div className="preview__notes" data-testid="preview-notes">
              <span className="preview__notes-label">
                {noteCount} note{noteCount === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                className="button button--ghost button--small"
                data-testid="expand-notes-button"
                onClick={() => setAllNotes(true)}
              >
                Expand all
              </button>
              <button
                type="button"
                className="button button--ghost button--small"
                data-testid="collapse-notes-button"
                onClick={() => setAllNotes(false)}
              >
                Collapse all
              </button>
            </div>
          )}
          <DiagramViewport
            svg={reviewSvg}
            size={{ width: document.width, height: document.height }}
            svgTestId="preview-svg"
            onNoteToggle={toggleNote}
            onNodeSelect={onNodeSelect}
            onSemanticMessageSelect={onSemanticMessageSelect}
            onSemanticOccurrenceSelect={onSemanticOccurrenceSelect}
            activeNodeId={activeNodeId}
            activeSemanticMessageId={activeSemanticMessageId}
            maximized={maximized}
            onToggleMaximize={onToggleMaximize}
            reviewMode={reviewMode}
            linkedTransform={linkedTransform}
            onTransformChange={onTransformChange}
            activeReviewChange={activeReviewChange}
            focusReviewChange={focusReviewChange}
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
