/**
 * SVG renderer for sequence diagrams.
 *
 * Pure and deterministic: given a {@link DiagramLayout} it produces an SVG
 * string. The renderer never parses source text (Rule 1) — it only consumes the
 * layout produced by the layout engine. All drawing decisions live here, so the
 * layout engine stays free of any SVG concerns.
 */
import {
  ARROW_HEAD_HEIGHT,
  ARROW_HEAD_SIZE,
  MARGIN_X,
  PARTICIPANT_BOX_HEIGHT,
  STROKE_WIDTH,
  TITLE_HEIGHT,
  type DiagramLayout,
  type MessageLayout,
  type NoteLayout,
  type ParticipantLayout,
} from "../../layout/geometry";

/** Escape text for safe inclusion inside SVG text elements. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render a participant's name box and its dashed lifeline. */
function renderParticipant(p: ParticipantLayout): string {
  const boxWidth = p.width;
  const boxX = p.x - boxWidth / 2;
  const box = `<rect x="${boxX.toFixed(2)}" y="${p.topY.toFixed(2)}" width="${boxWidth}" height="${PARTICIPANT_BOX_HEIGHT}" rx="4" fill="#eef2f7" stroke="#94a3b8" stroke-width="${STROKE_WIDTH}"/>`;
  const label = `<text x="${p.x.toFixed(2)}" y="${(p.topY + PARTICIPANT_BOX_HEIGHT / 2 + 4).toFixed(2)}" text-anchor="middle" font-size="13" fill="#0f172a">${escapeXml(p.label)}</text>`;
  const line = `<line x1="${p.x.toFixed(2)}" y1="${p.topY.toFixed(2)}" x2="${p.x.toFixed(2)}" y2="${p.bottomY.toFixed(2)}" stroke="#94a3b8" stroke-width="${STROKE_WIDTH}" stroke-dasharray="4 3"/>`;
  return `${box}${label}${line}`;
}

/** Build the polygon points string for an arrowhead pointing left or right. */
function arrowHeadPoints(msg: MessageLayout): string | null {
  if (msg.startX === msg.endX) {
    // Self / broken arrow: nothing to point at.
    return null;
  }
  const dir = msg.endX > msg.startX ? 1 : -1;
  const tipX = msg.endX;
  const baseX = msg.endX - dir * ARROW_HEAD_SIZE;
  const half = ARROW_HEAD_HEIGHT / 2;
  return `${tipX.toFixed(2)},${msg.y.toFixed(2)} ${baseX.toFixed(2)},${(msg.y - half).toFixed(2)} ${baseX.toFixed(2)},${(msg.y + half).toFixed(2)}`;
}

/** Render a single message arrow (line, optional head, and label). */
function renderMessage(msg: MessageLayout): string {
  const dashed = msg.kind === "response" ? ' stroke-dasharray="5 4"' : "";
  const line = `<line x1="${msg.startX.toFixed(2)}" y1="${msg.y.toFixed(2)}" x2="${msg.endX.toFixed(2)}" y2="${msg.y.toFixed(2)}" fill="none" stroke="#0f172a" stroke-width="${STROKE_WIDTH}">${dashed}/>`;

  // Solid sync messages get a filled head; dashed response (return) messages
  // are headless, keeping the two arrow styles visually distinct.
  const points = msg.kind === "sync" ? arrowHeadPoints(msg) : null;
  const head = points ? `<polygon points="${points}" fill="#0f172a"/>` : "";

  const labelX = ((msg.startX + msg.endX) / 2).toFixed(2);
  const label = msg.label
    ? `<text x="${labelX}" y="${(msg.y - 6).toFixed(2)}" text-anchor="middle" font-size="12" fill="#334155">${escapeXml(msg.label)}</text>`
    : "";

  return `${line}${head}${label}`;
}

/** Size of the dog-ear fold on a note's top-right corner, in pixels. */
const NOTE_FOLD_SIZE = 14;

/** Render a single note box (a rectangle with a folded top-right corner). */
function renderNote(note: NoteLayout): string {
  const { x, y, width, height } = note;
  const fold = NOTE_FOLD_SIZE;

  // The note body is a rectangle whose top-right corner is folded back. The
  // path traces the outer edge, leaving a triangular notch at the fold.
  const body =
    `M${x.toFixed(2)},${(y + fold).toFixed(2)} ` +
    `L${x.toFixed(2)},${y.toFixed(2)} ` +
    `L${(x + width - fold).toFixed(2)},${y.toFixed(2)} ` +
    `L${(x + width).toFixed(2)},${(y + fold).toFixed(2)} ` +
    `L${(x + width).toFixed(2)},${(y + height).toFixed(2)} ` +
    `L${x.toFixed(2)},${(y + height).toFixed(2)} Z`;
  const box = `<path d="${body}" fill="#fff7d6" stroke="#d4a72c" stroke-width="${STROKE_WIDTH}" stroke-linejoin="round"/>`;

  // The fold is a small triangle filling the notch, drawn a shade darker so it
  // reads as the paper turned over.
  const foldPath =
    `M${(x + width - fold).toFixed(2)},${y.toFixed(2)} ` +
    `L${(x + width - fold).toFixed(2)},${(y + fold).toFixed(2)} ` +
    `L${(x + width).toFixed(2)},${(y + fold).toFixed(2)} Z`;
  const foldFill = `<path d="${foldPath}" fill="#efe0a8" stroke="#d4a72c" stroke-width="${STROKE_WIDTH}" stroke-linejoin="round"/>`;

  const labelX = (x + width / 2).toFixed(2);
  const labelY = (y + height / 2 + 4).toFixed(2);
  const label = `<text x="${labelX}" y="${labelY}" text-anchor="middle" font-size="12" fill="#5b4600">${escapeXml(note.text)}</text>`;

  return `${box}${foldFill}${label}`;
}

/** Render the diagram title, centered horizontally near the top. */
function renderTitle(layout: DiagramLayout): string {
  const title = layout.title ?? "";
  const x = (layout.width / 2).toFixed(2);
  const y = (TITLE_HEIGHT / 2 + 6).toFixed(2);
  return `<text x="${x}" y="${y}" text-anchor="middle" font-size="16" font-weight="600" fill="#0f172a">${escapeXml(title)}</text>`;
}

/** Produce a complete SVG document string for the given layout. */
export function renderDiagramToSvg(layout: DiagramLayout): string {
  const width = Math.max(MARGIN_X * 2, layout.width);
  const height = Math.max(
    PARTICIPANT_BOX_HEIGHT + (layout.title ? TITLE_HEIGHT : 0),
    layout.height,
  );

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);

  if (layout.title) {
    parts.push(renderTitle(layout));
  }

  for (const p of layout.participants) {
    parts.push(renderParticipant(p));
  }
  for (const msg of layout.messages) {
    parts.push(renderMessage(msg));
  }
  for (const note of layout.notes ?? []) {
    parts.push(renderNote(note));
  }

  parts.push("</svg>");
  return parts.join("");
}
