/**
 * Event-flow preview.
 *
 * A sibling of {@link ./Preview}, deliberately thinner: an event flow has no
 * notes to expand and no paused-render mode, so this renders the document and
 * hands it to the same {@link DiagramViewport} the sequence preview uses. Sharing
 * the viewport is what gives an event flow pan, zoom, fit and a minimap for free,
 * and it means source↔diagram selection works identically in both languages —
 * the viewport only knows about `data-node-id`, not about what produced it.
 */
import { useMemo } from "react";
import { analyzeEventFlow } from "../../language/eventflow/parser";
import { renderEventFlowDocument } from "./eventflow-to-svg";
import DiagramViewport from "./DiagramViewport";

export interface EventFlowPreviewProps {
  /** The event-flow DSL source. */
  source: string;
  /** Called with a node id when the user clicks the element it represents. */
  onNodeSelect?: (nodeId: string) => void;
  /** The node to highlight, following the editor's caret. */
  activeNodeId?: string | null;
}

export default function EventFlowPreview({
  source,
  onNodeSelect,
  activeNodeId = null,
}: EventFlowPreviewProps) {
  const document = useMemo(() => {
    // Parsing here rather than taking an AST keeps this component's contract the
    // same as the sequence preview's: it is handed source, nothing else.
    const { flow } = analyzeEventFlow(source);
    return renderEventFlowDocument(flow);
  }, [source]);

  if (document.width === 0 || document.height === 0) {
    return (
      <div className="preview" data-testid="event-flow-preview">
        <p className="preview__empty" data-testid="event-flow-empty">
          Nothing to draw yet — declare an event, a producer and a consumer.
        </p>
      </div>
    );
  }

  return (
    <div className="preview" data-testid="event-flow-preview">
      <DiagramViewport
        svg={document.svg}
        size={{ width: document.width, height: document.height }}
        svgTestId="preview-svg"
        resetKey={source}
        onNodeSelect={onNodeSelect}
        activeNodeId={activeNodeId}
      />
    </div>
  );
}
