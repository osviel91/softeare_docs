/**
 * Diagram viewport: pan, zoom, fit, and a minimap for the rendered SVG.
 *
 * The viewport knows nothing about diagram semantics — it receives finished SVG
 * markup plus its pixel size and only decides where that box sits inside the
 * pane. All geometry lives in {@link ./viewport}, so the interaction layer is a
 * thin wrapper: wheel to zoom (anchored on the cursor), drag to pan, arrow keys
 * and buttons for discrete moves.
 *
 * The SVG is injected once and then moved with a CSS transform, so panning and
 * zooming never re-render the diagram or re-parse the DSL.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  centeredTransform,
  fitTransform,
  panBy,
  toPercent,
  zoomAtCenter,
  zoomAtPoint,
  IDENTITY_TRANSFORM,
  ZOOM_STEP,
  type Size,
  type ViewportTransform,
} from "./viewport";

export type DiagramViewportTransform = ViewportTransform;

export interface DiagramViewportProps {
  /** The rendered SVG document. */
  svg: string;
  /** Natural pixel size of that document. */
  size: Size;
  /** Pixels panned by one arrow-key press. */
  keyboardStep?: number;
  /** Bumping this value re-fits the diagram (e.g. when a new one loads). */
  resetKey?: string;
  /** Test id for the element holding the SVG markup. */
  svgTestId?: string;
  /**
   * Called with a note index when the user activates that note's bullet. The
   * bullets live inside the injected SVG, so activation is handled by delegation
   * on the content element rather than by React children.
   */
  onNoteToggle?: (noteIndex: number) => void;
  /**
   * Called with a node's stable id when the user clicks the element that
   * represents it. The ids come from the renderer (`data-node-id`), which derives
   * them from the AST, so the shell can map a click back to a source range
   * without matching any text.
   */
  onNodeSelect?: (nodeId: string) => void;
  onSemanticMessageSelect?: (messageId: string, nodeId: string | null) => void;
  onCausalNodeSelect?: (nodeId: string) => void;
  /**
   * The node to highlight — the statement the editor's caret is on. Highlighting
   * is a class toggle on the injected markup rather than a re-render, so it never
   * disturbs the diagram or the pan/zoom transform.
   */
  activeNodeId?: string | null;
  activeSemanticMessageId?: string | null;
  /** Whether the shell has expanded this preview to its full workspace. */
  maximized?: boolean;
  /** Toggles the preview-only app layout. */
  onToggleMaximize?: () => void;
  /** Use the smaller control rail and minimap intended for side-by-side review. */
  reviewMode?: boolean;
  /** Optional shared transform for linked comparison panes. */
  linkedTransform?: DiagramViewportTransform | null;
  onTransformChange?: (transform: DiagramViewportTransform) => void;
  activeReviewChange?: string | null;
  /**
   * A review target to reveal. When it changes, the pane centers it, so
   * Previous/Next visibly moves to the decorated element instead of only
   * recolouring it. Kept separate from `activeReviewChange` because the class
   * toggle must not depend on geometry.
   */
  focusReviewChange?: string | null;
}

/** Pixels to pan per arrow key press. */
const KEYBOARD_PAN_STEP = 48;

/** Read an element's content-box size, with a usable fallback for tests. */
function measure(element: HTMLElement | null): Size {
  if (!element) return { width: 800, height: 600 };
  const rect = element.getBoundingClientRect();
  return {
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

/** The centre of a rendered SVG element, in the diagram's own coordinates. */
function elementCentre(element: SVGGraphicsElement): { x: number; y: number } {
  // jsdom has no getBBox; a real browser does, and it is the only measure in
  // diagram units rather than screen pixels.
  const box = typeof element.getBBox === "function" ? element.getBBox() : null;
  if (box && (box.width > 0 || box.height > 0))
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const rect = element.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0)
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  return { x: 0, y: 0 };
}

/** The note index carried by the closest bullet ancestor of `target`, if any. */
export function noteIndexFromTarget(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null;
  const bullet = target.closest("[data-note-index]");
  if (!bullet) return null;
  const index = Number(bullet.getAttribute("data-note-index"));
  return Number.isInteger(index) ? index : null;
}

/** The stable node id of the closest rendered element that carries one. */
export function nodeIdFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const node = target.closest("[data-node-id]");
  return node?.getAttribute("data-node-id") ?? null;
}

/** The participant name carried by the closest draggable group, if any. */
export function participantDragName(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const group = target.closest("[data-participant-id]");
  return group?.getAttribute("data-participant-id") ?? null;
}

/** The semantic badge carrying the pointer or keyboard event, if any. */
function semanticTarget(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest("[data-semantic-message-id], [data-semantic-message-name]");
}

export default function DiagramViewport({
  svg,
  size,
  keyboardStep = KEYBOARD_PAN_STEP,
  resetKey = "",
  svgTestId = "viewport-content",
  onNoteToggle,
  onNodeSelect,
  onSemanticMessageSelect,
  onCausalNodeSelect,
  activeNodeId = null,
  activeSemanticMessageId = null,
  maximized = false,
  onToggleMaximize,
  reviewMode = false,
  linkedTransform = null,
  onTransformChange,
  activeReviewChange = null,
  focusReviewChange = null,
}: DiagramViewportProps) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // The element holding the injected SVG, so the active-node highlight can be a
  // class toggle rather than a re-render.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [paneSize, setPaneSize] = useState<Size>(() => measure(null));
  const [transform, setTransform] =
    useState<ViewportTransform>(IDENTITY_TRANSFORM);
  // Latest camera, readable synchronously so a burst of interactions in one
  // event batch accumulates instead of each computing from a stale render.
  const transformRef = useRef<ViewportTransform>(IDENTITY_TRANSFORM);
  // Read the callback through a ref so `updateTransform` keeps one identity for
  // the pane's whole life. Callers wire linking conditionally (the callback is
  // undefined while unlinked), and an identity change here would re-run the
  // auto-fit effect and reset both cameras each time linking is toggled.
  const onTransformChangeRef = useRef(onTransformChange);
  onTransformChangeRef.current = onTransformChange;
  // Local camera changes flow outward; an adopted peer camera is written with
  // the plain setter below and never reported back, which is what stops a
  // linked pair from echoing a change endlessly between the two panes.
  const updateTransform = useCallback(
    (next: ViewportTransform | ((current: ViewportTransform) => ViewportTransform)) => {
      const value =
        typeof next === "function" ? next(transformRef.current) : next;
      transformRef.current = value;
      setTransform(value);
      onTransformChangeRef.current?.(value);
    },
    [],
  );
  const [isPanning, setIsPanning] = useState(false);
  // Drag origin lives in a ref: it changes on every pointer move and must not
  // cause a re-render of its own.
  // Whether the pointer moved during the current press, so a pan is not read as
  // a click on whatever happened to be under it.
  const movedSincePointerDown = useRef(false);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );

  // Track the pane's size so fit/center stay correct when the layout changes.
  // ResizeObserver is absent in jsdom, hence the guard.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    setPaneSize(measure(pane));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setPaneSize(measure(pane)));
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!linkedTransform) return;
    const current = transformRef.current;
    if (
      current.x === linkedTransform.x &&
      current.y === linkedTransform.y &&
      current.scale === linkedTransform.scale
    )
      return;
    // Adopt the peer camera without reporting it outward: this pane follows,
    // it does not become the new source.
    transformRef.current = linkedTransform;
    setTransform(linkedTransform);
  }, [linkedTransform]);

  const fit = useCallback(() => {
    updateTransform(fitTransform(size, paneSize));
  }, [size, paneSize, updateTransform]);

  const resetTo100 = useCallback(() => {
    updateTransform(centeredTransform(size, paneSize));
  }, [size, paneSize, updateTransform]);

  // Fit whenever a different diagram arrives (and once the pane is measured).
  // Without this a diagram larger than the pane opens off-screen.
  //
  // Depend on the measured numbers, not the `size`/`paneSize` objects: callers
  // routinely pass a fresh `{ width, height }` literal each render, which would
  // otherwise change `fit`'s identity, re-run this effect, and — when the
  // camera is linked — report a new camera to the parent on every render,
  // looping forever.
  useEffect(() => {
    updateTransform(fitTransform(size, paneSize));
  }, [
    size.width,
    size.height,
    paneSize.width,
    paneSize.height,
    resetKey,
    updateTransform,
  ]);

  // Wheel zoom must be a non-passive native listener: React attaches wheel
  // handlers passively, so preventDefault there is ignored and the pane would
  // scroll behind the zoom.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = pane.getBoundingClientRect();
      const anchor = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      // Trackpads report small deltas, a wheel ~100 per notch; an exponential
      // step keeps both feeling proportional rather than jumpy.
      const factor = Math.exp(-event.deltaY / 400);
       updateTransform((current) => zoomAtPoint(current, factor, anchor));
    };

    pane.addEventListener("wheel", onWheel, { passive: false });
    return () => pane.removeEventListener("wheel", onWheel);
  }, [updateTransform]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return; // left button / touch / pen only
    // A note bullet is a control, not a drag surface. Capturing the pointer here
    // would retarget the follow-up click at the pane, so the delegated toggle
    // would never see it — and a press on a bullet should not pan anyway.
    if (onNoteToggle && noteIndexFromTarget(event.target) !== null) return;
    // Semantic badges are controls inside the draggable canvas. Pointer capture
    // would retarget their click to the pane and lose the delegated activation.
    if (semanticTarget(event.target)) return;
    movedSincePointerDown.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    // Past a couple of pixels this is a pan, not a click on what is underneath.
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2)
      movedSincePointerDown.current = true;
    drag.x = event.clientX;
    drag.y = event.clientY;
    updateTransform((current) => panBy(current, dx, dy));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = keyboardStep;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    updateTransform((current) => panBy(current, move[0], move[1]));
  };

  const zoomIn = () =>
    updateTransform((current) => zoomAtCenter(current, ZOOM_STEP, paneSize));
  const zoomOut = () =>
    updateTransform((current) => zoomAtCenter(current, 1 / ZOOM_STEP, paneSize));

  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onFullscreenChange = () =>
      setFullscreen(document.fullscreenElement === viewportRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement === viewportRef.current) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void viewportRef.current?.requestFullscreen?.().catch(() => {});
    }
  };

  // Note bullets are part of the injected SVG, so activation is delegated: find
  // the nearest element carrying `data-note-index` and report it. This keeps the
  // viewport agnostic about what a note is.
  const onContentClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const index = noteIndexFromTarget(event.target);
    if (index !== null) {
      onNoteToggle?.(index);
      return;
    }
    // A pan ends with a click on the content element, so a selection only counts
    // when the pointer stayed put.
    if (movedSincePointerDown.current) return;
    const semantic = semanticTarget(event.target);
    if (semantic) {
      const messageId = semantic.getAttribute("data-semantic-message-id");
      if (messageId) onSemanticMessageSelect?.(messageId, nodeIdFromTarget(semantic));
      else {
        const nodeId = nodeIdFromTarget(semantic);
        if (nodeId) onNodeSelect?.(nodeId);
      }
      return;
    }
    if (!onNodeSelect && !onCausalNodeSelect) return;
    const causalNode = event.target instanceof Element
      ? event.target.closest("[data-causal-id]")?.getAttribute("data-causal-id")
      : null;
    if (causalNode) onCausalNodeSelect?.(causalNode);
    const nodeId = nodeIdFromTarget(event.target);
    if (nodeId !== null) onNodeSelect?.(nodeId);
  };

  // Highlight the active node by toggling a class on the injected SVG. Doing it
  // imperatively keeps the highlight out of the layout/render pipeline, so it can
  // never change the drawing or the transform.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    for (const element of content.querySelectorAll(".svg-node--active")) {
      element.classList.remove("svg-node--active");
    }
    if (!activeNodeId) return;
    const target = content.querySelector(
      `[data-node-id="${CSS.escape(activeNodeId)}"]`,
    );
    target?.classList.add("svg-node--active");
  }, [activeNodeId, svg]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    for (const element of content.querySelectorAll(".semantic-message--active"))
      element.classList.remove("semantic-message--active");
    if (!activeSemanticMessageId) return;
    for (const element of content.querySelectorAll(
      `[data-semantic-message-id="${CSS.escape(activeSemanticMessageId)}"]`,
    )) element.classList.add("semantic-message--active");
  }, [activeSemanticMessageId, svg]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    for (const element of content.querySelectorAll(".review-change--active"))
      element.classList.remove("review-change--active");
    if (!activeReviewChange) return;
    for (const element of content.querySelectorAll(
      `[data-review-change="${CSS.escape(activeReviewChange)}"]`,
    )) element.classList.add("review-change--active");
  }, [activeReviewChange, svg]);

  // Reveal the focused review change by centering it in the pane. This is what
  // makes Next/Previous move the viewport to the actual decoration; the class
  // toggle above only recolours it. A pane that has no element for the target
  // (an addition in BASE, say) simply stays put.
  useEffect(() => {
    if (!focusReviewChange) return;
    const content = contentRef.current;
    const pane = paneRef.current;
    if (!content || !pane) return;
    const target = content.querySelector<SVGGraphicsElement>(
      `[data-review-change="${CSS.escape(focusReviewChange)}"]`,
    );
    if (!target) return;
    const centre = elementCentre(target);
    const box = measure(pane);
    updateTransform((current) => ({
      ...current,
      x: box.width / 2 - centre.x * current.scale,
      y: box.height / 2 - centre.y * current.scale,
    }));
  }, [focusReviewChange, svg, updateTransform]);

  const onContentKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const semantic = semanticTarget(event.target);
    if (semantic) {
      event.preventDefault();
      const messageId = semantic.getAttribute("data-semantic-message-id");
      if (messageId) onSemanticMessageSelect?.(messageId, nodeIdFromTarget(semantic));
      else {
        const nodeId = nodeIdFromTarget(semantic);
        if (nodeId) onNodeSelect?.(nodeId);
      }
      return;
    }
    const causalNode = event.target instanceof Element
      ? event.target.closest("[data-causal-id]")?.getAttribute("data-causal-id")
      : null;
    if (causalNode) {
      event.preventDefault();
      onCausalNodeSelect?.(causalNode);
      return;
    }
    if (!onNoteToggle) return;
    const index = noteIndexFromTarget(event.target);
    if (index === null) return;
    // Keep the page from scrolling on Space, which is the reason to reject the
    // browser default rather than relying on the pane's arrow-key handler.
    event.preventDefault();
    onNoteToggle(index);
  };

  /**
   * Start dragging a participant name.
   *
   * The participant groups live inside the injected SVG and carry
   * `data-participant-id`; this puts that name on the drag payload as plain text,
   * which is what the editor's drop handler reads to insert it. The id (not the
   * display label) is the token the DSL understands.
   */
  const onContentDragStart = (event: ReactDragEvent<HTMLDivElement>) => {
    const name = participantDragName(event.target);
    if (name === null || !event.dataTransfer) return;
    event.dataTransfer.setData("text/plain", name);
    event.dataTransfer.effectAllowed = "copy";
  };

  // Minimap geometry: the whole diagram scaled into a fixed preview box.
  const minimap = useMemo(() => {
    const box = reviewMode
      ? { width: 132, height: 90 }
      : { width: 168, height: 116 };
    const scale = Math.min(
      1,
      box.width / Math.max(1, size.width),
      box.height / Math.max(1, size.height),
    );
    return {
      scale,
      width: size.width * scale,
      height: size.height * scale,
    };
  }, [reviewMode, size]);

  // The slice of the diagram currently visible, in minimap pixels.
  const view = {
    x: (-transform.x / transform.scale) * minimap.scale,
    y: (-transform.y / transform.scale) * minimap.scale,
    width: (paneSize.width / transform.scale) * minimap.scale,
    height: (paneSize.height / transform.scale) * minimap.scale,
  };

  /** Center the main view on a point given in minimap coordinates. */
  const navigateFromMinimap = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 1) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const target = {
      x: (event.clientX - rect.left) / minimap.scale,
      y: (event.clientY - rect.top) / minimap.scale,
    };
    updateTransform((current) => ({
      ...current,
      x: paneSize.width / 2 - target.x * current.scale,
      y: paneSize.height / 2 - target.y * current.scale,
    }));
  };

  return (
    <div
      ref={viewportRef}
      className={`viewport${reviewMode ? " viewport--review" : ""}`}
      data-testid="diagram-viewport"
    >
      <div
        ref={paneRef}
        className={`viewport__pane${isPanning ? " viewport__pane--panning" : ""}`}
        data-testid="viewport-pane"
        aria-label="Diagram canvas: drag to pan, scroll to zoom"
        tabIndex={0}
        // Move the dot grid with the view so panning and zooming feel connected
        // to the canvas rather than to a static backdrop.
        style={{
          backgroundPosition: `${transform.x}px ${transform.y}px`,
          backgroundSize: `${22 * transform.scale}px ${22 * transform.scale}px`,
        }}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          ref={contentRef}
          className="viewport__content"
          data-testid={svgTestId}
          style={{
            width: size.width,
            height: size.height,
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
          // The SVG comes from this project's renderer, which escapes all text.
          dangerouslySetInnerHTML={{ __html: svg }}
          onClick={onContentClick}
          onKeyDown={onContentKeyDown}
          onDragStart={onContentDragStart}
        />
      </div>

      <div className="viewport__rail" role="group" aria-label="Zoom controls">
        <button
          type="button"
          className="icon-button"
          data-testid="zoom-in"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={zoomIn}
        >
          +
        </button>
        <button
          type="button"
          className="icon-button"
          data-testid="zoom-out"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={zoomOut}
        >
          −
        </button>
        <span
          className="viewport__zoom"
          data-testid="zoom-level"
          aria-live="polite"
        >
          {toPercent(transform.scale)}%
        </span>
        <button
          type="button"
          className="icon-button"
          data-testid="zoom-fit"
          aria-label="Fit diagram to view"
          title="Fit diagram to view"
          onClick={fit}
        >
          ⤢
        </button>
        <button
          type="button"
          className="icon-button icon-button--text"
          data-testid="zoom-reset"
          aria-label="Reset zoom to 100%"
          title="Reset zoom to 100%"
          onClick={resetTo100}
        >
          1:1
        </button>
        {onToggleMaximize ? (
          <button
            type="button"
            className="icon-button"
            data-testid="preview-maximize"
            aria-label={
              maximized
                ? "Restore workspace panels"
                : "Maximize diagram preview"
            }
            title={
              maximized
                ? "Restore workspace panels"
                : "Maximize diagram preview"
            }
            onClick={onToggleMaximize}
          >
            {maximized ? "⊡" : "⤢"}
          </button>
        ) : null}
        <button
          type="button"
          className="icon-button"
          data-testid="preview-fullscreen"
          aria-label={
            fullscreen ? "Exit presentation fullscreen" : "Present fullscreen"
          }
          title={
            fullscreen ? "Exit presentation fullscreen" : "Present fullscreen"
          }
          onClick={toggleFullscreen}
        >
          {fullscreen ? "⊡" : "⛶"}
        </button>
      </div>

      <div className={`minimap${reviewMode ? " minimap--review" : ""}`} data-testid="minimap" aria-hidden="true">
        <div
          className="minimap__canvas"
          style={{ width: minimap.width, height: minimap.height }}
          onPointerDown={navigateFromMinimap}
          onPointerMove={navigateFromMinimap}
        >
          {/*
            Drawn as an image rather than inline markup: inlining would put a
            second copy of every label in the DOM, so screen readers would read
            the diagram twice and text queries would match twice.
          */}
          <img
            className="minimap__image"
            data-testid="minimap-image"
            alt=""
            width={minimap.width}
            height={minimap.height}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          />
          <span
            className="minimap__view"
            data-testid="minimap-view"
            style={{
              left: view.x,
              top: view.y,
              width: Math.max(4, view.width),
              height: Math.max(4, view.height),
            }}
          />
        </div>
      </div>
    </div>
  );
}
