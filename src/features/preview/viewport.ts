/**
 * Pan/zoom math for the diagram canvas.
 *
 * Pure and framework-free: every function takes a transform and returns a new
 * one, so the interaction layer stays a thin wrapper and the geometry is unit
 * testable on its own. A transform maps diagram coordinates to container
 * coordinates as `screen = diagram * scale + translate`, which is exactly what a
 * CSS `translate(...) scale(...)` pair applies.
 */

/** The pan/zoom state of the canvas. */
export interface ViewportTransform {
  /** Zoom factor; 1 means the diagram's natural pixel size. */
  scale: number;
  /** Horizontal translation, in container pixels. */
  x: number;
  /** Vertical translation, in container pixels. */
  y: number;
}

/** Size in pixels, used for the diagram and for its container. */
export interface Size {
  width: number;
  height: number;
}

/** A point in container (screen) coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** Smallest zoom factor the canvas allows. */
export const MIN_SCALE = 0.1;

/** Largest zoom factor the canvas allows. */
export const MAX_SCALE = 8;

/** Factor applied by one zoom-in or zoom-out step. */
export const ZOOM_STEP = 1.25;

/** Margin left around the diagram when fitting it into the viewport. */
export const FIT_PADDING = 32;

/** The neutral transform: natural size, at the container origin. */
export const IDENTITY_TRANSFORM: ViewportTransform = { scale: 1, x: 0, y: 0 };

/** Clamp a zoom factor into the supported range. */
export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Translate by a screen-space delta. */
export function panBy(
  transform: ViewportTransform,
  dx: number,
  dy: number,
): ViewportTransform {
  return { ...transform, x: transform.x + dx, y: transform.y + dy };
}

/**
 * Zoom while keeping the diagram point under `anchor` pinned to that screen
 * position — the behaviour that makes wheel-zoom feel anchored to the cursor.
 *
 * With `screen = diagram * scale + translate`, holding `anchor` fixed means
 * solving `anchor = diagram * scale' + translate'` for the new translation.
 */
export function zoomAtPoint(
  transform: ViewportTransform,
  factor: number,
  anchor: Point,
): ViewportTransform {
  const scale = clampScale(transform.scale * factor);
  // No change when already at a limit: avoids drifting translation.
  if (scale === transform.scale) return transform;
  const ratio = scale / transform.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - transform.x) * ratio,
    y: anchor.y - (anchor.y - transform.y) * ratio,
  };
}

/** Zoom about the center of a container. */
export function zoomAtCenter(
  transform: ViewportTransform,
  factor: number,
  container: Size,
): ViewportTransform {
  return zoomAtPoint(transform, factor, {
    x: container.width / 2,
    y: container.height / 2,
  });
}

/** Center the diagram in the container at its natural size. */
export function centeredTransform(
  content: Size,
  container: Size,
): ViewportTransform {
  return {
    scale: 1,
    x: (container.width - content.width) / 2,
    y: (container.height - content.height) / 2,
  };
}

/**
 * Scale the diagram down so it fits the container with padding, then center it.
 *
 * The scale is capped at 1 so fitting never magnifies: a small diagram stays at
 * its natural, crisp size instead of being blown up to fill the canvas.
 */
export function fitTransform(
  content: Size,
  container: Size,
  padding: number = FIT_PADDING,
): ViewportTransform {
  const availableWidth = Math.max(1, container.width - padding * 2);
  const availableHeight = Math.max(1, container.height - padding * 2);
  const scale = clampScale(
    Math.min(
      1,
      availableWidth / Math.max(1, content.width),
      availableHeight / Math.max(1, content.height),
    ),
  );
  return {
    scale,
    x: (container.width - content.width * scale) / 2,
    y: (container.height - content.height * scale) / 2,
  };
}

/** The zoom factor as a whole percentage, for display. */
export function toPercent(scale: number): number {
  return Math.round(scale * 100);
}
