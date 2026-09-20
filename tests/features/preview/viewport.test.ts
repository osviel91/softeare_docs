import { describe, expect, it } from "vitest";
import {
  clampScale,
  centeredTransform,
  fitTransform,
  IDENTITY_TRANSFORM,
  MAX_SCALE,
  MIN_SCALE,
  panBy,
  toPercent,
  zoomAtCenter,
  zoomAtPoint,
  ZOOM_STEP,
  type ViewportTransform,
} from "../../../src/features/preview/viewport";

/** Apply a transform the way CSS does, to check where a point lands. */
function project(t: ViewportTransform, x: number, y: number) {
  return { x: x * t.scale + t.x, y: y * t.scale + t.y };
}

describe("clampScale", () => {
  it("keeps a scale inside the supported range", () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(0.5)).toBe(0.5);
  });

  it("clamps below the minimum and above the maximum", () => {
    expect(clampScale(0.0001)).toBe(MIN_SCALE);
    expect(clampScale(1000)).toBe(MAX_SCALE);
  });
});

describe("panBy", () => {
  it("adds a screen-space delta without touching the scale", () => {
    const moved = panBy({ scale: 2, x: 10, y: 20 }, -4, 6);
    expect(moved).toEqual({ scale: 2, x: 6, y: 26 });
  });

  it("does not mutate the input transform", () => {
    const original: ViewportTransform = { scale: 1, x: 0, y: 0 };
    panBy(original, 5, 5);
    expect(original).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe("zoomAtPoint", () => {
  it("keeps the diagram point under the anchor pinned to it", () => {
    const before: ViewportTransform = { scale: 1, x: 40, y: 20 };
    const anchor = { x: 200, y: 150 };
    // The diagram coordinate currently under the anchor.
    const diagramPoint = {
      x: (anchor.x - before.x) / before.scale,
      y: (anchor.y - before.y) / before.scale,
    };

    const after = zoomAtPoint(before, ZOOM_STEP, anchor);
    const landed = project(after, diagramPoint.x, diagramPoint.y);

    expect(landed.x).toBeCloseTo(anchor.x);
    expect(landed.y).toBeCloseTo(anchor.y);
  });

  it("multiplies the scale by the factor", () => {
    const after = zoomAtPoint(IDENTITY_TRANSFORM, 2, { x: 0, y: 0 });
    expect(after.scale).toBe(2);
  });

  it("returns the same transform when already at a limit", () => {
    const atMax: ViewportTransform = { scale: MAX_SCALE, x: 5, y: 5 };
    // Identity, not merely equal: a new object would let translation drift.
    expect(zoomAtPoint(atMax, 2, { x: 100, y: 100 })).toBe(atMax);
  });

  it("clamps rather than overshooting the maximum", () => {
    const after = zoomAtPoint({ scale: MAX_SCALE / 2, x: 0, y: 0 }, 100, {
      x: 0,
      y: 0,
    });
    expect(after.scale).toBe(MAX_SCALE);
  });
});

describe("zoomAtCenter", () => {
  it("anchors on the middle of the container", () => {
    const container = { width: 400, height: 200 };
    const center = { x: 200, y: 100 };
    const before = IDENTITY_TRANSFORM;
    const diagramPoint = {
      x: (center.x - before.x) / before.scale,
      y: (center.y - before.y) / before.scale,
    };

    const after = zoomAtCenter(before, ZOOM_STEP, container);
    const landed = project(after, diagramPoint.x, diagramPoint.y);
    expect(landed.x).toBeCloseTo(center.x);
    expect(landed.y).toBeCloseTo(center.y);
  });
});

describe("centeredTransform", () => {
  it("centers the content at natural size", () => {
    const t = centeredTransform(
      { width: 200, height: 100 },
      { width: 600, height: 400 },
    );
    expect(t).toEqual({ scale: 1, x: 200, y: 150 });
  });

  it("gives a negative offset for content larger than the container", () => {
    const t = centeredTransform(
      { width: 800, height: 600 },
      { width: 400, height: 300 },
    );
    expect(t.x).toBe(-200);
    expect(t.y).toBe(-150);
  });
});

describe("fitTransform", () => {
  it("shrinks oversized content to fit with padding", () => {
    const t = fitTransform(
      { width: 1000, height: 500 },
      { width: 600, height: 400 },
      20,
    );
    // Width binds: (600 - 40) / 1000 = 0.56.
    expect(t.scale).toBeCloseTo(0.56);
    // Centered on both axes.
    expect(t.x).toBeCloseTo((600 - 1000 * t.scale) / 2);
    expect(t.y).toBeCloseTo((400 - 500 * t.scale) / 2);
  });

  it("never magnifies content smaller than the container", () => {
    const t = fitTransform(
      { width: 100, height: 80 },
      { width: 1000, height: 800 },
    );
    expect(t.scale).toBe(1);
    expect(t.x).toBe(450);
    expect(t.y).toBe(360);
  });

  it("respects the minimum scale for enormous content", () => {
    const t = fitTransform(
      { width: 1_000_000, height: 1_000_000 },
      { width: 100, height: 100 },
    );
    expect(t.scale).toBe(MIN_SCALE);
  });

  it("survives a zero-sized container", () => {
    expect(() =>
      fitTransform({ width: 100, height: 100 }, { width: 0, height: 0 }),
    ).not.toThrow();
  });
});

describe("toPercent", () => {
  it("renders a scale as a whole percentage", () => {
    expect(toPercent(1)).toBe(100);
    expect(toPercent(0.5)).toBe(50);
    expect(toPercent(1.254)).toBe(125);
  });
});
