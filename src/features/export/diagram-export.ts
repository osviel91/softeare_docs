/**
 * Diagram export: one canonical SVG per document, with PNG and PDF derived
 * from it.
 *
 * The renderer stays the single source of drawing truth. A PNG is the same SVG
 * rasterized through a canvas, and a PDF is the same raster embedded as an
 * image XObject — neither re-runs layout, so an export can never disagree with
 * the preview. PNG encoding uses the browser's own canvas codec and PDF is
 * assembled byte by byte here, which keeps the dependency surface at zero (no
 * jsPDF, no pdf-lib, no pako).
 *
 * Environment: everything below the SVG is browser-only. When the DOM image or
 * canvas APIs are missing (a test runner, a worker without OffscreenCanvas) the
 * raster functions reject with a descriptive `Error` rather than leaking a
 * `TypeError` from deep inside the platform.
 */
import type { SequenceDiagram } from "../../domain/diagram/ast";
import { renderDiagramDocument } from "../preview/diagram-to-svg";

/** Raster scale used when a caller does not pick one. */
const DEFAULT_SCALE = 2;

/** File name stem used when the document has no usable name. */
const DEFAULT_FILE_STEM = "diagram";

/**
 * Bounds for a requested raster scale: below this the diagram loses detail,
 * above it the extra pixels are almost always wasted memory.
 */
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

/** Options shared by every export format. */
export interface DiagramExportOptions {
  format: "svg" | "png" | "pdf";
  /** Colour scheme; defaults to `"light"` in the renderer. */
  theme?: "light" | "dark";
  /** Canvas fill: `"white"` (theme paper), `"transparent"`, or a CSS colour. */
  background?: string;
  /** Raster scale for PNG/PDF. Defaults to 2. */
  scale?: number;
  /** Extra padding around the drawing, in px. */
  padding?: number;
  /** Draw the diagram title when it has one. Defaults to true. */
  includeTitle?: boolean;
  /** File name stem, without extension. Defaults to `"diagram"`. */
  title?: string;
}

/** The canonical SVG plus the canvas size it was rendered at. */
export interface DiagramExportSvg {
  svg: string;
  width: number;
  height: number;
}

/**
 * Clamp a requested raster scale to a finite, sane value.
 *
 * A missing or non-finite scale falls back to {@link DEFAULT_SCALE}; anything
 * outside the supported range is clamped rather than rejecting, so a slider
 * bounds case never breaks an export.
 */
export function normalizeScale(scale: number | undefined): number {
  if (scale === undefined || !Number.isFinite(scale) || scale <= 0) {
    return DEFAULT_SCALE;
  }
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The canonical SVG for a source document, with the options applied.
 *
 * `format` is accepted so the same options object flows through every export
 * path; it does not change the SVG itself. An invalid or absent AST renders as
 * an empty canvas, exactly as the editor's preview does.
 */
export function exportDiagramSvg(
  ast: SequenceDiagram | null,
  options: DiagramExportOptions = { format: "svg" },
): DiagramExportSvg {
  const document = renderDiagramDocument(ast, {
    theme: options.theme,
    background: options.background,
    padding: options.padding,
    includeTitle: options.includeTitle,
  });
  return {
    svg: document.svg,
    width: document.width,
    height: document.height,
  };
}

/** Turn a document name into a safe file name stem. */
function fileStem(title: string | undefined): string {
  const trimmed = (title ?? "").trim();
  // Path separators and characters Windows reserves would either lose the file
  // in a subdirectory or be rejected outright, so they become dashes. Control
  // characters are dropped for the same reason (filtered by code point rather
  // than a control-character regex, which is both clearer and lint-clean).
  const safe = trimmed
    .replace(/[\\/:*?"<>|]/g, "-")
    .split("")
    .filter((character) => character.charCodeAt(0) >= 0x20)
    .join("")
    .trim();
  return safe === "" ? DEFAULT_FILE_STEM : safe;
}

/** A sensible file name for an export, e.g. `"checkout-flow.svg"`. */
export function exportFileName(options: DiagramExportOptions): string {
  return `${fileStem(options.title)}.${options.format}`;
}

/** The MIME type to hand a download for a format. */
export function exportMimeType(format: DiagramExportOptions["format"]): string {
  switch (format) {
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "pdf":
      return "application/pdf";
  }
}

/** A rasterized SVG: the canvas, its context, and the pixel dimensions used. */
interface RasterizedSvg {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * Fail with a clear message when the platform cannot rasterize at all.
 *
 * The check is deliberately explicit: a missing `document`/`Image` otherwise
 * surfaces as `ReferenceError`/`TypeError` at the point of use, which says
 * nothing about what the caller should do instead.
 */
function requireRasterizer(): void {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new Error(
      "cannot rasterize SVG: this environment has no document or Image (export SVG instead, or run in a browser)",
    );
  }
}

/**
 * Decode an SVG string into an image element.
 *
 * A `data:` URL is used instead of an object URL so there is no lifecycle to
 * manage and the same call works in a worker-like environment.
 */
function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        new Error(
          "cannot rasterize SVG: the browser failed to decode the SVG image",
        ),
      );
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/**
 * Draw an SVG onto a canvas at `scale` and hand back the canvas.
 *
 * This is the one rasterization path: PNG encodes it and PDF reads its pixels,
 * so both formats are guaranteed to be the same picture.
 */
async function rasterizeSvg(
  svg: string,
  width: number,
  height: number,
  scale: number,
): Promise<RasterizedSvg> {
  requireRasterizer();

  const pixelWidth = Math.max(1, Math.round(width * normalizeScale(scale)));
  const pixelHeight = Math.max(1, Math.round(height * normalizeScale(scale)));

  const canvas = document.createElement("canvas");
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;

  const context =
    typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (!context) {
    throw new Error(
      "cannot rasterize SVG: no 2D canvas context is available (a canvas implementation is required for PNG/PDF export)",
    );
  }

  const image = await loadSvgImage(svg);
  context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
  return { canvas, context, pixelWidth, pixelHeight };
}

/** Decode the base64 payload of a canvas `data:` URL into bytes. */
function bytesFromDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    throw new Error(
      "cannot encode PNG: the canvas returned a malformed data URL",
    );
  }
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (!meta.includes(";base64")) {
    return new TextEncoder().encode(decodeURIComponent(payload));
  }
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Encode a canvas to PNG bytes, preferring `toBlob` and falling back. */
async function canvasToPngBytes(
  canvas: HTMLCanvasElement,
): Promise<Uint8Array> {
  if (typeof canvas.toBlob === "function") {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (blob) {
      return new Uint8Array(await blob.arrayBuffer());
    }
  }
  if (typeof canvas.toDataURL === "function") {
    return bytesFromDataUrl(canvas.toDataURL("image/png"));
  }
  throw new Error(
    "cannot encode PNG: the canvas exposes neither toBlob nor toDataURL",
  );
}

/** Rasterize an SVG string to PNG bytes. Rejects when no canvas is available. */
export async function svgToPng(
  svg: string,
  width: number,
  height: number,
  scale: number,
): Promise<Uint8Array> {
  const raster = await rasterizeSvg(svg, width, height, scale);
  return canvasToPngBytes(raster.canvas);
}

/**
 * Compress bytes with zlib deflate, or return null when the platform cannot.
 *
 * `CompressionStream("deflate")` emits a zlib wrapper, which is exactly what a
 * PDF `/FlateDecode` filter expects; the raw-deflate variant of the same API
 * would be rejected by viewers. The source is a `ReadableStream` rather than a
 * `Blob` because not every DOM implementation gives a `Blob` a `.stream()`.
 */
async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (
    typeof CompressionStream !== "function" ||
    typeof ReadableStream !== "function"
  ) {
    return null;
  }
  try {
    // Hand the stream the exact byte range as an `ArrayBuffer`: the view may be
    // an offset view, and its buffer is typed as possibly shared.
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const source = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer));
        controller.close();
      },
    });
    const stream = source.pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    // Any platform gap (no Response, no streams) degrades to an uncompressed
    // image XObject, which is larger but still a valid PDF.
    return null;
  }
}

/**
 * Flatten RGBA samples onto white and drop the alpha channel.
 *
 * A PDF image XObject without an explicit soft mask treats alpha as opaque, so
 * leaving the alpha bytes in place would render every semi-transparent pixel
 * black. Compositing onto white matches how the diagram reads on screen when
 * the SVG background is transparent.
 */
function toDeviceRgb(data: Uint8ClampedArray): Uint8Array {
  const pixelCount = Math.floor(data.length / 4);
  const rgb = new Uint8Array(pixelCount * 3);
  for (let index = 0; index < pixelCount; index += 1) {
    const alpha = data[index * 4 + 3];
    if (alpha === 255) {
      rgb[index * 3] = data[index * 4];
      rgb[index * 3 + 1] = data[index * 4 + 1];
      rgb[index * 3 + 2] = data[index * 4 + 2];
    } else if (alpha === 0) {
      rgb[index * 3] = 255;
      rgb[index * 3 + 1] = 255;
      rgb[index * 3 + 2] = 255;
    } else {
      const inverse = 255 - alpha;
      rgb[index * 3] = Math.round(
        (data[index * 4] * alpha + 255 * inverse) / 255,
      );
      rgb[index * 3 + 1] = Math.round(
        (data[index * 4 + 1] * alpha + 255 * inverse) / 255,
      );
      rgb[index * 3 + 2] = Math.round(
        (data[index * 4 + 2] * alpha + 255 * inverse) / 255,
      );
    }
  }
  return rgb;
}

/** One indirect object in the PDF: a dictionary, optionally with a stream. */
interface PdfObject {
  dict: string;
  stream?: Uint8Array;
}

/** Round a number to at most three decimals without trailing zeros. */
function formatNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * Assemble a single-page PDF around one DeviceRGB image XObject.
 *
 * The file is the minimal classic structure viewers expect: a catalog, a page
 * tree, one page whose content matrix scales the unit square to the MediaBox
 * and paints `/Im0`, the image itself, and an info dictionary. Object offsets
 * are recorded as they are written so the xref table and its `startxref` are
 * exact; the image samples are FlateDecode-compressed when the platform can
 * deflate them and stored raw otherwise.
 */
function buildPdf(
  pageWidth: number,
  pageHeight: number,
  pixelWidth: number,
  pixelHeight: number,
  samples: Uint8Array,
  compressed: boolean,
): Uint8Array {
  const encoder = new TextEncoder();
  const width = formatNumber(pageWidth);
  const height = formatNumber(pageHeight);
  const content = encoder.encode(
    `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`,
  );
  const imageFilter = compressed ? " /Filter /FlateDecode" : "";

  const objects: PdfObject[] = [
    { dict: "<< /Type /Catalog /Pages 2 0 R >>" },
    { dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    {
      dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    },
    { dict: `<< /Length ${content.length} >>`, stream: content },
    {
      dict: `<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8${imageFilter} /Length ${samples.length} >>`,
      stream: samples,
    },
    { dict: "<< /Producer (SecuenceDiagrams) /Creator (SecuenceDiagrams) >>" },
  ];

  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  push(encoder.encode("%PDF-1.4\n"));
  // A comment with high-bit bytes marks the file as binary for transfer tools.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets[index] = offset;
    push(encoder.encode(`${index + 1} 0 obj\n${object.dict}\n`));
    if (object.stream) {
      push(encoder.encode("stream\n"));
      push(object.stream);
      push(encoder.encode("\nendstream\n"));
    }
    push(encoder.encode("endobj\n"));
  });

  const xrefOffset = offset;
  const xrefEntries = [
    "0000000000 65535 f \n",
    ...offsets.map((objectOffset) => `${pad10(objectOffset)} 00000 n \n`),
  ];
  push(encoder.encode(`xref\n0 ${objects.length + 1}\n`));
  for (const entry of xrefEntries) {
    push(encoder.encode(entry));
  }
  push(
    encoder.encode(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    ),
  );

  const pdf = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    pdf.set(chunk, cursor);
    cursor += chunk.length;
  }
  return pdf;
}

/** Left-pad a byte offset to the 10 digits an xref entry requires. */
function pad10(value: number): string {
  return value.toString().padStart(10, "0");
}

/**
 * A single-page PDF containing the diagram.
 *
 * The page is the diagram's size in points and the image is drawn to fill it;
 * `scale` only raises the pixel resolution of the embedded raster, so a large
 * scale yields a sharper print without changing the page geometry.
 */
export async function svgToPdf(
  svg: string,
  width: number,
  height: number,
  scale: number,
): Promise<Uint8Array> {
  const raster = await rasterizeSvg(svg, width, height, scale);
  if (typeof raster.context.getImageData !== "function") {
    throw new Error(
      "cannot build PDF: the canvas context cannot read back pixels (getImageData is unavailable)",
    );
  }
  const image = raster.context.getImageData(
    0,
    0,
    raster.pixelWidth,
    raster.pixelHeight,
  );
  const samples = toDeviceRgb(image.data);
  const compressed = await deflate(samples);
  return buildPdf(
    width,
    height,
    raster.pixelWidth,
    raster.pixelHeight,
    compressed ?? samples,
    compressed !== null,
  );
}
