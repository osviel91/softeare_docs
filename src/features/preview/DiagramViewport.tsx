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

export default function DiagramViewport({
  svg,
  size,
  keyboardStep = KEYBOARD_PAN_STEP,
  resetKey = "",
  svgTestId = "viewport-content",
}: DiagramViewportProps) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [paneSize, setPaneSize] = useState<Size>(() => measure(null));
  const [transform, setTransform] =
    useState<ViewportTransform>(IDENTITY_TRANSFORM);
  const [isPanning, setIsPanning] = useState(false);
  // Drag origin lives in a ref: it changes on every pointer move and must not
  // cause a re-render of its own.
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

  const fit = useCallback(() => {
    setTransform(fitTransform(size, paneSize));
  }, [size, paneSize]);

  const resetTo100 = useCallback(() => {
    setTransform(centeredTransform(size, paneSize));
  }, [size, paneSize]);

  // Fit whenever a different diagram arrives (and once the pane is measured).
  // Without this a diagram larger than the pane opens off-screen.
  useEffect(() => {
    fit();
  }, [fit, resetKey]);

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
      setTransform((current) => zoomAtPoint(current, factor, anchor));
    };

    pane.addEventListener("wheel", onWheel, { passive: false });
    return () => pane.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return; // left button / touch / pen only
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
    drag.x = event.clientX;
    drag.y = event.clientY;
    setTransform((current) => panBy(current, dx, dy));
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
    setTransform((current) => panBy(current, move[0], move[1]));
  };

  const zoomIn = () =>
    setTransform((current) => zoomAtCenter(current, ZOOM_STEP, paneSize));
  const zoomOut = () =>
    setTransform((current) => zoomAtCenter(current, 1 / ZOOM_STEP, paneSize));

  // Minimap geometry: the whole diagram scaled into a fixed preview box.
  const minimap = useMemo(() => {
    const box = { width: 168, height: 116 };
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
  }, [size]);

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
    setTransform((current) => ({
      ...current,
      x: paneSize.width / 2 - target.x * current.scale,
      y: paneSize.height / 2 - target.y * current.scale,
    }));
  };

  return (
    <div className="viewport" data-testid="diagram-viewport">
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
          className="viewport__content"
          data-testid={svgTestId}
          style={{
            width: size.width,
            height: size.height,
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
          // The SVG comes from this project's renderer, which escapes all text.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      <div className="viewport__rail" role="group" aria-label="Zoom controls">
        <button
          type="button"
          className="icon-button"
          data-testid="zoom-in"
          aria-label="Zoom in"
          onClick={zoomIn}
        >
          +
        </button>
        <button
          type="button"
          className="icon-button"
          data-testid="zoom-out"
          aria-label="Zoom out"
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
          onClick={fit}
        >
          ⤢
        </button>
        <button
          type="button"
          className="icon-button icon-button--text"
          data-testid="zoom-reset"
          aria-label="Reset zoom to 100%"
          onClick={resetTo100}
        >
          1:1
        </button>
      </div>

      <div className="minimap" data-testid="minimap" aria-hidden="true">
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
