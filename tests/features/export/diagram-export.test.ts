import { afterEach, describe, expect, it, vi } from "vitest";
import type { SequenceDiagram } from "../../../src/domain/diagram/ast";
import {
  exportDiagramSvg,
  exportFileName,
  exportMimeType,
  normalizeScale,
  svgToPdf,
  svgToPng,
} from "../../../src/features/export/diagram-export";
import { renderDiagramDocument } from "../../../src/renderer/pipeline/diagram-to-svg";
import { parse as parseSource } from "../../../src/language/parser/parser";

const SOURCE = `title Checkout
participant Customer
participant Payments
Customer -> Payments: Authorize
Payments --> Customer: Approved
note over Payments: retries
`;

/** A 1x1 PNG, used as the payload a stubbed canvas hands back. */
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Parse the shared fixture, failing loudly so a parse break is obvious. */
function fixtureAst(): SequenceDiagram {
  const { ast } = parseSource(SOURCE);
  if (ast === null) throw new Error("fixture failed to parse");
  return ast;
}

/** An image stand-in that "loads" as soon as a source is assigned. */
class StubImage {
  onload: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  set src(_value: string) {
    // The rasterizer assigns its handlers before the source, so firing here is
    // enough to resolve its promise on the next microtask.
    queueMicrotask(() => this.onload?.(new Event("load")));
  }
}

/** Opaque RGBA samples for a canvas of the requested pixel size. */
function opaquePixels(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 10;
    data[index + 1] = 20;
    data[index + 2] = 30;
    data[index + 3] = 255;
  }
  return data;
}

/**
 * Replace the canvas APIs with a deterministic stand-in.
 *
 * jsdom ships neither a 2D context nor an encoder, so the only way to exercise
 * the PNG/PDF byte paths here is to inject a canvas that records what it was
 * asked to do and returns fixed pixels.
 */
function stubCanvas(pngDataUrl = PNG_DATA_URL): { draws: unknown[][] } {
  const draws: unknown[][] = [];
  const context = {
    drawImage: (...args: unknown[]) => {
      draws.push(args);
    },
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      data: opaquePixels(width, height),
      width,
      height,
      colorSpace: "srgb",
    }),
  };

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  );
  // Returning null forces the `toDataURL` fallback, which is the path jsdom can
  // describe most precisely (a real data URL with a real base64 payload).
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback: BlobCallback) => callback(null),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
    () => pngDataUrl,
  );
  vi.stubGlobal("Image", StubImage);
  return { draws };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("exportDiagramSvg", () => {
  it("renders the same AST twice byte-identically", () => {
    const first = exportDiagramSvg(fixtureAst(), { format: "svg" });
    const second = exportDiagramSvg(fixtureAst(), { format: "svg" });
    expect(first.svg).toBe(second.svg);
    expect(first.width).toBe(second.width);
    expect(first.height).toBe(second.height);
    // Guard: the fixture must actually draw something.
    expect(first.svg).toContain("data-node-id");
  });

  it("is the preview's own SVG, so PNG and PDF share the canonical layout", () => {
    const exported = exportDiagramSvg(fixtureAst(), { format: "png" });
    const preview = renderDiagramDocument(fixtureAst());
    expect(exported.svg).toBe(preview.svg);
    expect(exported.width).toBe(preview.width);
    expect(exported.height).toBe(preview.height);
  });

  it("applies theme, background, title and padding through one options object", () => {
    const light = exportDiagramSvg(fixtureAst(), { format: "svg" });
    const dark = exportDiagramSvg(fixtureAst(), {
      format: "svg",
      theme: "dark",
      background: "transparent",
      includeTitle: false,
    });
    expect(dark.svg).not.toBe(light.svg);
    expect(dark.svg).not.toContain('fill="#ffffff"');
    expect(dark.svg).not.toContain(">Checkout<");
    // Transparent means no full-canvas rectangle at the very start.
    expect(dark.svg).not.toContain("<rect width=");

    const padded = exportDiagramSvg(fixtureAst(), {
      format: "svg",
      padding: 12,
    });
    expect(padded.width).toBe(light.width + 24);
    expect(padded.height).toBe(light.height + 24);
  });

  it("degrades to an empty canvas for an invalid or absent AST", () => {
    const exported = exportDiagramSvg(null, { format: "svg" });
    expect(exported.svg.startsWith("<svg ")).toBe(true);
    expect(exported.width).toBeGreaterThan(0);
    expect(exported.height).toBeGreaterThan(0);
  });
});

describe("exportFileName", () => {
  it("defaults the stem to 'diagram' and uses the format as the extension", () => {
    expect(exportFileName({ format: "svg" })).toBe("diagram.svg");
    expect(exportFileName({ format: "png" })).toBe("diagram.png");
    expect(exportFileName({ format: "pdf" })).toBe("diagram.pdf");
  });

  it("uses the document name as the stem", () => {
    expect(exportFileName({ format: "svg", title: "checkout-flow" })).toBe(
      "checkout-flow.svg",
    );
    expect(exportFileName({ format: "pdf", title: "checkout-flow" })).toBe(
      "checkout-flow.pdf",
    );
  });

  it("replaces characters a file system would reject", () => {
    expect(exportFileName({ format: "png", title: "a/b:c*d" })).toBe(
      "a-b-c-d.png",
    );
  });

  it("falls back to 'diagram' for a blank name", () => {
    expect(exportFileName({ format: "svg", title: "   " })).toBe("diagram.svg");
  });

  it("maps every format to its MIME type", () => {
    expect(exportMimeType("svg")).toBe("image/svg+xml");
    expect(exportMimeType("png")).toBe("image/png");
    expect(exportMimeType("pdf")).toBe("application/pdf");
  });
});

describe("normalizeScale", () => {
  it("defaults to 2 for a missing or unusable scale", () => {
    expect(normalizeScale(undefined)).toBe(2);
    expect(normalizeScale(Number.NaN)).toBe(2);
    expect(normalizeScale(0)).toBe(2);
    expect(normalizeScale(-3)).toBe(2);
  });

  it("keeps a sane scale as asked and clamps the extremes", () => {
    expect(normalizeScale(1)).toBe(1);
    expect(normalizeScale(3.5)).toBe(3.5);
    expect(normalizeScale(1000)).toBe(8);
    expect(normalizeScale(0.01)).toBe(0.25);
  });
});

describe("rasterization without a canvas", () => {
  it("rejects PNG with a descriptive error instead of a TypeError", async () => {
    await expect(svgToPng("<svg/>", 10, 10, 1)).rejects.toThrow(
      /no 2D canvas context/,
    );
  });

  it("rejects PDF with a descriptive error instead of a TypeError", async () => {
    await expect(svgToPdf("<svg/>", 10, 10, 1)).rejects.toThrow(
      /no 2D canvas context/,
    );
  });

  it("rejects when the environment has no document at all", async () => {
    vi.stubGlobal("document", undefined);
    await expect(svgToPng("<svg/>", 10, 10, 1)).rejects.toThrow(
      /no document or Image/,
    );
  });
});

describe("svgToPng with a stubbed canvas", () => {
  it("returns bytes with the PNG signature", async () => {
    const { draws } = stubCanvas();
    const bytes = await svgToPng("<svg/>", 100, 50, 2);

    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(Array.from(bytes.subarray(4, 8))).toEqual([0x0d, 0x0a, 0x1a, 0x0a]);
    // The image is drawn at the scaled pixel size, filling the canvas.
    expect(draws).toHaveLength(1);
    expect(draws[0].slice(1)).toEqual([0, 0, 200, 100]);
  });

  it("compresses the payload with a real PNG data URL", async () => {
    stubCanvas();
    const bytes = await svgToPng("<svg/>", 4, 4, 1);
    expect(bytes.length).toBeGreaterThan(8);
  });
});

describe("svgToPdf with a stubbed canvas", () => {
  /** The PDF rendered as latin1, which preserves every byte position. */
  async function pdfText(width = 120, height = 80, scale = 2): Promise<string> {
    stubCanvas();
    const bytes = await svgToPdf("<svg/>", width, height, scale);
    return new TextDecoder("latin1").decode(bytes);
  }

  it("emits a valid single-page PDF whose startxref points at the xref", async () => {
    const text = await pdfText();

    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("%%EOF");
    expect(text).toContain("/Type /Page /Parent");
    expect(text).toContain("/Subtype /Image");
    expect(text).toContain("/ColorSpace /DeviceRGB");
    expect(text).toContain("/MediaBox [0 0 120 80]");

    const marker = text.lastIndexOf("startxref");
    expect(marker).toBeGreaterThan(0);
    const offset = Number(
      text
        .slice(marker + "startxref".length)
        .trim()
        .split(/\s+/)[0],
    );
    expect(Number.isInteger(offset)).toBe(true);
    expect(text.slice(offset, offset + 4)).toBe("xref");
  });

  it("records one xref entry per object plus the free entry", async () => {
    const text = await pdfText();
    // Six objects (catalog, pages, page, contents, image, info).
    expect(text).toContain("xref\n0 7\n");
    expect(text).toContain("0000000000 65535 f ");
    expect(text).toContain("/Root 1 0 R");
  });

  it("page is the diagram size while the image carries the scaled pixels", async () => {
    const text = await pdfText(120, 80, 2);
    expect(text).toContain("/MediaBox [0 0 120 80]");
    expect(text).toContain("/Width 240 /Height 160");
  });

  it("deflates the samples, which is what /FlateDecode expects", async () => {
    const text = await pdfText();
    expect(text).toContain("/Filter /FlateDecode");
  });

  it("falls back to uncompressed samples without CompressionStream", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const text = await pdfText(10, 10, 1);
    expect(text).not.toContain("/FlateDecode");
    // 10 x 10 pixels of DeviceRGB = 300 raw bytes.
    expect(text).toContain("/Length 300");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });
});
