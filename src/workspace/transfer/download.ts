/**
 * Browser download helper for generated files.
 *
 * Export produces bytes in memory (a ZIP, an SVG, …); this is the one place that
 * turns them into a download. Keeping it separate means the archive and export
 * code stays DOM-free and testable, and tests can stub a single function.
 */

/** Trigger a browser download of `bytes` under `filename`. */
export function downloadBytes(
  bytes: Uint8Array,
  filename: string,
  type = "application/octet-stream",
): void {
  // Hand `Blob` the exact byte range as an `ArrayBuffer`: the view's own buffer
  // may be larger (an offset view) or typed as possibly shared.
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([buffer], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
