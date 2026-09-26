/**
 * SVG renderer for sequence diagrams.
 *
 * Pure and deterministic: given a {@link DiagramLayout} it produces an SVG
 * string. The renderer never parses source text (Rule 1) — it only consumes the
 * layout produced by the layout engine. All drawing decisions live here, so the
 * layout engine stays free of any SVG concerns.
 *
 * Colour is the one exception to "the layout decides everything": a theme is a
 * presentation choice the same drawing can be rendered under, so it is threaded
 * through here as {@link RenderOptions.theme} rather than baked into geometry.
 */
import {
  ACTIVATION_WIDTH,
  ACTOR_FIGURE_HEIGHT,
  ARROW_HEAD_HEIGHT,
  ARROW_HEAD_SIZE,
  MARGIN_X,
  MESSAGE_BADGE_FONT_SIZE,
  MESSAGE_BADGE_INSET,
  MESSAGE_BADGE_RADIUS,
  MESSAGE_BADGE_TEXT_OFFSET,
  NOTE_BULLET_RADIUS,
  NOTE_LINE_HEIGHT,
  PARTICIPANT_BOX_HEIGHT,
  SELF_MESSAGE_LABEL_GAP,
  STROKE_WIDTH,
  TITLE_HEIGHT,
  type ActivationLayout,
  type DiagramLayout,
  type FragmentLayout,
  type MessageLayout,
  type NoteLayout,
  type ParticipantLayout,
} from "../../layout/geometry";

/** The colour schemes the renderer knows how to draw. */
export type RenderTheme = "light" | "dark";

/** Options that change what the renderer draws without changing the layout. */
export interface RenderOptions {
  /**
   * Indices (into {@link DiagramLayout.notes}) of the notes whose callout box is
   * shown. Every other note renders as a collapsed bullet. Expansion is a
   * render-time choice so the layout — and therefore the canvas size — does not
   * change when a bullet is toggled.
   */
  expandedNotes?: ReadonlySet<number>;
  /**
   * Colour scheme. Defaults to `"light"`, so an existing caller that passes no
   * theme keeps the exact markup it rendered before.
   */
  theme?: RenderTheme;
  /**
   * Canvas fill: `"white"` (the default) means the theme's paper — white under
   * the light theme, the dark paper under the dark one — `"transparent"` omits
   * the background rectangle entirely, and any other value is used verbatim as a
   * CSS colour (so `"#ffffff"` pins a white page even in dark theme).
   */
  background?: string;
  /**
   * Whether to draw the diagram title when the layout carries one. Defaults to
   * true; `false` drops the title element without changing the canvas size
   * (the layout already reserved room for it).
   */
  includeTitle?: boolean;
  /** Extra padding around the drawing, in px. Defaults to 0. */
  padding?: number;
}

/**
 * Every colour the renderer draws with, for one theme.
 *
 * Centralising the palette is what lets a theme be a single lookup instead of a
 * scatter of conditionals, and it keeps the light palette — the default — a
 * literal copy of the historical hard-coded colours, which is what makes
 * `theme: "light"` byte-identical to the pre-theme renderer.
 */
interface RenderPalette {
  /** Fill of the full-canvas background rectangle. */
  canvas: string;
  /** Fill of a participant name box / actor head. */
  participantFill: string;
  /** Slate stroke: lifelines, participant and actor outlines. */
  line: string;
  /** Primary ink: arrows, activation outlines, title and name text. */
  ink: string;
  /** Muted ink: message labels and fragment text. */
  label: string;
  /** Opaque fill of the step-number badge. */
  badgeFill: string;
  /** Opaque fill of an activation bar. */
  activationFill: string;
  /** Fill of a note callout box. */
  noteFill: string;
  /** Stroke of a note callout box, its fold and its bullet. */
  noteStroke: string;
  /** Fill of a note's folded corner. */
  noteFoldFill: string;
  /** Text inside a note callout. */
  noteText: string;
  /** Ring around an expanded note's bullet. */
  noteRing: string;
  /** Stroke of a fragment frame, tag and divider. */
  fragmentStroke: string;
  /** Fill of a fragment's kind tag. */
  fragmentTagFill: string;
}

/** The palette per theme. Light is the historical default, kept literal. */
const PALETTES: Record<RenderTheme, RenderPalette> = {
  light: {
    canvas: "#ffffff",
    participantFill: "#eef2f7",
    line: "#94a3b8",
    ink: "#0f172a",
    label: "#334155",
    badgeFill: "#ffffff",
    activationFill: "#ffffff",
    noteFill: "#fff7d6",
    noteStroke: "#d4a72c",
    noteFoldFill: "#efe0a8",
    noteText: "#5b4600",
    noteRing: "#b8860b",
    fragmentStroke: "#64748b",
    fragmentTagFill: "#e2e8f0",
  },
  dark: {
    canvas: "#0f172a",
    participantFill: "#1e293b",
    line: "#94a3b8",
    ink: "#e2e8f0",
    label: "#cbd5e1",
    badgeFill: "#1e293b",
    activationFill: "#1e293b",
    noteFill: "#3f3208",
    noteStroke: "#d4a72c",
    noteFoldFill: "#5c4a10",
    noteText: "#fde68a",
    noteRing: "#fbbf24",
    fragmentStroke: "#94a3b8",
    fragmentTagFill: "#1e293b",
  },
};

/** Escape text for safe inclusion inside SVG text elements. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The `data-node-id` attribute for an element, or an empty string when the
 * layout element carries no id.
 *
 * Hand-built layouts (mostly in tests) predate node ids, so every emission is
 * conditional: a layout without ids must render exactly as it did before.
 */
function nodeIdAttribute(nodeId: string | undefined): string {
  return nodeId === undefined ? "" : ` data-node-id="${escapeXml(nodeId)}"`;
}

/**
 * The drawing padding, clamped to a finite non-negative number.
 *
 * A missing, negative, or non-finite value means "no padding", which keeps a
 * bad value from producing a canvas with a negative width.
 */
function normalizePadding(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

/** Resolve the canvas fill keyword for a theme. */
function resolveBackground(background: string, palette: RenderPalette): string {
  // "white" is a keyword for the theme's paper, not a literal colour, so a dark
  // diagram is dark by default. Pin a literal white with "#ffffff".
  return background === "white" ? palette.canvas : background;
}

/**
 * Render a participant's name box and its dashed lifeline.
 *
 * The whole group is draggable and carries `data-participant-id`, so the UI can
 * let the user drag a participant name into the editor to insert it without
 * retyping. Dragging is inert until a `dragstart` handler supplies a payload; the
 * renderer only marks the group.
 */
function renderParticipant(
  p: ParticipantLayout,
  palette: RenderPalette,
): string {
  const boxWidth = p.width;
  const boxX = p.x - boxWidth / 2;
  const boxHeight = p.boxHeight ?? PARTICIPANT_BOX_HEIGHT;
  const lines = p.labelLines ?? [p.label];
  const box = `<rect x="${boxX.toFixed(2)}" y="${p.topY.toFixed(2)}" width="${boxWidth}" height="${boxHeight}" rx="4" fill="${palette.participantFill}" stroke="${palette.line}" stroke-width="${STROKE_WIDTH}"${nodeIdAttribute(p.nodeId)}/>`;
  const firstY = p.topY + boxHeight / 2 - (lines.length - 1) * 7.5 + 4;
  const label = `<text x="${p.x.toFixed(2)}" y="${firstY.toFixed(2)}" text-anchor="middle" font-size="13" fill="${palette.ink}">${lines.map((line, index) => `<tspan x="${p.x.toFixed(2)}" dy="${index === 0 ? 0 : 15}">${escapeXml(line)}</tspan>`).join("")}</text>`;
  const line = `<line x1="${p.x.toFixed(2)}" y1="${p.lifelineTop.toFixed(2)}" x2="${p.x.toFixed(2)}" y2="${p.bottomY.toFixed(2)}" stroke="${palette.line}" stroke-width="${STROKE_WIDTH}" stroke-dasharray="4 3"/>`;
  return `<g class="participant" data-participant-id="${escapeXml(p.id)}" data-participant-label="${escapeXml(p.label)}" draggable="true">${box}${label}${line}</g>`;
}

/**
 * Render an actor as a stick figure with its label beneath.
 *
 * An actor owns the same lifeline and message endpoints as a participant; only
 * the glyph differs, which is why the layout band grows so the figure and a name
 * box can share a top edge.
 */
function renderActor(p: ParticipantLayout, palette: RenderPalette): string {
  const cx = p.x;
  const top = p.topY;
  const headR = 6;
  const headCy = top + headR;
  const bodyTop = top + headR * 2;
  const bodyBottom = top + ACTOR_FIGURE_HEIGHT;
  const bodyMid = bodyTop + (bodyBottom - bodyTop) * 0.42;
  const figure =
    `<circle cx="${cx.toFixed(2)}" cy="${headCy.toFixed(2)}" r="${headR}" fill="${palette.participantFill}" stroke="${palette.line}" stroke-width="${STROKE_WIDTH}"/>` +
    `<line x1="${cx.toFixed(2)}" y1="${bodyTop.toFixed(2)}" x2="${cx.toFixed(2)}" y2="${bodyBottom.toFixed(2)}" stroke="${palette.line}" stroke-width="${STROKE_WIDTH}"/>` +
    `<line x1="${(cx - 8).toFixed(2)}" y1="${bodyMid.toFixed(2)}" x2="${(cx + 8).toFixed(2)}" y2="${bodyMid.toFixed(2)}" stroke="${palette.line}" stroke-width="${STROKE_WIDTH}"/>` +
    `<line x1="${cx.toFixed(2)}" y1="${bodyBottom.toFixed(2)}" x2="${(cx - 6).toFixed(2)}" y2="${top + ACTOR_FIGURE_HEIGHT + 2}" stroke="${palette.line}" stroke-width="${STROKE_WIDTH}"/>` +
    `<line x1="${cx.toFixed(2)}" y1="${bodyBottom.toFixed(2)}" x2="${(cx + 6).toFixed(2)}" y2="${top + ACTOR_FIGURE_HEIGHT + 2}" stroke="${palette.line}" stroke-width="${STROKE_WIDTH}"/>`;
  const lines = p.labelLines ?? [p.label];
  const label = `<text x="${cx.toFixed(2)}" y="${(top + ACTOR_FIGURE_HEIGHT + 15).toFixed(2)}" text-anchor="middle" font-size="13" fill="${palette.ink}">${lines.map((line, index) => `<tspan x="${cx.toFixed(2)}" dy="${index === 0 ? 0 : 15}">${escapeXml(line)}</tspan>`).join("")}</text>`;
  const line = `<line x1="${cx.toFixed(2)}" y1="${p.lifelineTop.toFixed(2)}" x2="${cx.toFixed(2)}" y2="${p.bottomY.toFixed(2)}" stroke="${palette.line}" stroke-width="${STROKE_WIDTH}" stroke-dasharray="4 3"/>`;
  return `<g class="participant participant--actor" data-participant-id="${escapeXml(p.id)}" data-participant-label="${escapeXml(p.label)}" data-participant-type="actor" draggable="true"${nodeIdAttribute(p.nodeId)}>${figure}${label}${line}</g>`;
}

/** Half-width of the cross mark drawn for a failed message. */
const CROSS_SIZE = 5;

/** Filled triangular head with its tip at (`tipX`, `tipY`), pointing along `dir`. */
function filledHead(
  tipX: number,
  tipY: number,
  dir: number,
  palette: RenderPalette,
): string {
  const baseX = tipX - dir * ARROW_HEAD_SIZE;
  const half = ARROW_HEAD_HEIGHT / 2;
  return `<polygon points="${tipX.toFixed(2)},${tipY.toFixed(2)} ${baseX.toFixed(2)},${(tipY - half).toFixed(2)} ${baseX.toFixed(2)},${(tipY + half).toFixed(2)}" fill="${palette.ink}"/>`;
}

/** Open (async) head: two strokes forming a chevron at the tip. */
function openHead(
  tipX: number,
  tipY: number,
  dir: number,
  palette: RenderPalette,
): string {
  const baseX = tipX - dir * ARROW_HEAD_SIZE;
  const half = ARROW_HEAD_HEIGHT / 2;
  return `<polyline class="arrow-open" points="${baseX.toFixed(2)},${(tipY - half).toFixed(2)} ${tipX.toFixed(2)},${tipY.toFixed(2)} ${baseX.toFixed(2)},${(tipY + half).toFixed(2)}" fill="none" stroke="${palette.ink}" stroke-width="${STROKE_WIDTH}"/>`;
}

/** Cross (failure) mark centered just inside the tip. */
function crossHead(
  tipX: number,
  tipY: number,
  dir: number,
  palette: RenderPalette,
): string {
  const cx = tipX - dir * (CROSS_SIZE + 1);
  const s = CROSS_SIZE;
  return `<path class="arrow-cross" d="M${(cx - s).toFixed(2)},${(tipY - s).toFixed(2)} L${(cx + s).toFixed(2)},${(tipY + s).toFixed(2)} M${(cx - s).toFixed(2)},${(tipY + s).toFixed(2)} L${(cx + s).toFixed(2)},${(tipY - s).toFixed(2)}" stroke="${palette.ink}" stroke-width="${STROKE_WIDTH}" fill="none"/>`;
}

/**
 * Render the ending(s) for a message whose head is at (`tipX`, `tipY`) and
 * whose travel direction is `dir` (+1 right, -1 left). `bidirectional` adds a
 * matching head at the tail as well.
 */
function renderHead(
  style: MessageLayout["arrowStyle"],
  tipX: number,
  tipY: number,
  dir: number,
  palette: RenderPalette,
  tailX?: number,
): string {
  switch (style) {
    case "none":
      return "";
    case "arrow":
      return filledHead(tipX, tipY, dir, palette);
    case "open":
      return openHead(tipX, tipY, dir, palette);
    case "cross":
      return crossHead(tipX, tipY, dir, palette);
    case "bidirectional": {
      const head = filledHead(tipX, tipY, dir, palette);
      const tail =
        tailX === undefined ? "" : filledHead(tailX, tipY, -dir, palette);
      return `${head}${tail}`;
    }
  }
}

/** Self-message geometry helpers keep the loop and its heads in one place. */
function renderSelfMessage(
  msg: MessageLayout,
  number: number,
  palette: RenderPalette,
): string {
  const loop = msg.selfLoop;
  if (!loop) return "";
  const x = msg.startX;
  const top = msg.y;
  const right = x + loop.width;
  const bottom = top + loop.height;
  const dashed = msg.lineStyle === "dashed" ? ' stroke-dasharray="5 4"' : "";

  // Rounded joins keep the three turns of the cycle from reading as spikes.
  const path = `<path d="M${x.toFixed(2)},${top.toFixed(2)} L${right.toFixed(2)},${top.toFixed(2)} L${right.toFixed(2)},${bottom.toFixed(2)} L${x.toFixed(2)},${bottom.toFixed(2)}" fill="none" stroke="${palette.ink}" stroke-width="${STROKE_WIDTH}" stroke-linejoin="round"${dashed}${nodeIdAttribute(msg.nodeId)}/>`;

  // The message comes back to the originating lifeline, so any head points left.
  // A bidirectional loop also marks the point where it leaves the lifeline.
  const head =
    renderHead(msg.arrowStyle, x, bottom, -1, palette) +
    (msg.arrowStyle === "bidirectional" ? filledHead(x, top, -1, palette) : "");

  // The label sits beside the loop, vertically centered on it, rather than
  // above an arrow that no longer runs horizontally.
  const lines = msg.labelLines ?? [msg.label];
  const label = msg.label
    ? `<text x="${(right + SELF_MESSAGE_LABEL_GAP).toFixed(2)}" y="${(top + loop.height / 2 - (lines.length - 1) * 7 + 4).toFixed(2)}" font-size="12" fill="${palette.label}">${lines.map((line, index) => `<tspan x="${(right + SELF_MESSAGE_LABEL_GAP).toFixed(2)}" dy="${index === 0 ? 0 : 14}">${escapeXml(line)}</tspan>`).join("")}</text>`
    : "";
  const semantic = renderSemanticBadge(
    msg,
    right + SELF_MESSAGE_LABEL_GAP,
    top + loop.height / 2 + (lines.length - 1) * 7 + 18,
    "start",
    palette,
  );

  return `${path}${head}${renderSequenceBadge(msg, number, palette)}${label}${semantic}`;
}

/** A restrained text-labelled affordance; semantics never rely on colour alone. */
function renderSemanticBadge(
  msg: MessageLayout,
  x: number,
  y: number,
  anchor: "middle" | "start",
  palette: RenderPalette,
): string {
  if (!msg.semantics) return "";
  const text = `${msg.semantics.kind.toUpperCase()} · ${msg.semantics.operation}`;
  const target = msg.semantics.messageRef
    ? `${nodeIdAttribute(msg.nodeId)} data-semantic-message-id="${escapeXml(msg.semantics.messageRef)}" data-semantic-kind="${msg.semantics.kind}" data-semantic-operation="${msg.semantics.operation}" tabindex="0" role="button" aria-label="Inspect ${escapeXml(text)} ${escapeXml(msg.semantics.name)}"`
    : `${nodeIdAttribute(msg.nodeId)} data-semantic-message-name="${escapeXml(msg.semantics.name)}" data-semantic-kind="${msg.semantics.kind}" data-semantic-operation="${msg.semantics.operation}" tabindex="0" role="button" aria-label="Inspect unbound ${escapeXml(text)} ${escapeXml(msg.semantics.name)}"`;
  return `<text class="semantic-message-badge" x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="${anchor}" font-size="9" font-weight="600" fill="${palette.label}"${target}>${escapeXml(text)}</text>`;
}

/**
 * Render the circled step number for a message.
 *
 * Every call and every response is numbered in source order, which makes the
 * order of the sequence legible at a glance. The badge sits on the arrow just
 * inside its tail (on a self-message, on the loop's top segment) and its opaque
 * fill masks the stroke underneath, so the line does not run through the digit.
 */
function renderSequenceBadge(
  msg: MessageLayout,
  number: number,
  palette: RenderPalette,
): string {
  const dir = msg.endX < msg.startX ? -1 : 1;
  const cx = msg.startX + dir * MESSAGE_BADGE_INSET;
  const cy = msg.y;
  const circle = `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${MESSAGE_BADGE_RADIUS}" fill="${palette.badgeFill}" stroke="${palette.ink}" stroke-width="${STROKE_WIDTH}"/>`;
  const text = `<text x="${cx.toFixed(2)}" y="${(cy + MESSAGE_BADGE_TEXT_OFFSET).toFixed(2)}" text-anchor="middle" font-size="${MESSAGE_BADGE_FONT_SIZE}" font-weight="600" fill="${palette.ink}">${number}</text>`;
  return `<g class="sequence-number" data-sequence-number="${number}">${circle}${text}</g>`;
}

/** Render a single message arrow (line, ending, step number, label). */
function renderMessage(
  msg: MessageLayout,
  number: number,
  palette: RenderPalette,
): string {
  // A self-message is a loop, not a horizontal arrow.
  if (msg.selfLoop)
    return `<g class="sequence-message" data-sequence-message="${number}"${msg.semantics?.messageRef ? ` data-semantic-message-id="${escapeXml(msg.semantics.messageRef)}"` : msg.semantics ? ` data-semantic-message-name="${escapeXml(msg.semantics.name)}"` : ""}>${renderSelfMessage(msg, number, palette)}</g>`;

  const dashed = msg.lineStyle === "dashed" ? ' stroke-dasharray="5 4"' : "";
  // `dashed` must sit inside the tag, before the self-closing slash: emitting it
  // after `>` would close the element early and swallow the arrowhead and label
  // as children, which SVG `<line>` cannot render.
  const line = `<line x1="${msg.startX.toFixed(2)}" y1="${msg.y.toFixed(2)}" x2="${msg.endX.toFixed(2)}" y2="${msg.y.toFixed(2)}" fill="none" stroke="${palette.ink}" stroke-width="${STROKE_WIDTH}"${dashed}${nodeIdAttribute(msg.nodeId)}/>`;

  const dir = msg.endX >= msg.startX ? 1 : -1;
  const head = renderHead(
    msg.arrowStyle,
    msg.endX,
    msg.y,
    dir,
    palette,
    msg.startX,
  );

  const labelX = ((msg.startX + msg.endX) / 2).toFixed(2);
  const lines = msg.labelLines ?? [msg.label];
  const label = msg.label
    ? `<text x="${labelX}" y="${(msg.y - 6 - (lines.length - 1) * 14).toFixed(2)}" text-anchor="middle" font-size="12" fill="${palette.label}">${lines.map((line, index) => `<tspan x="${labelX}" dy="${index === 0 ? 0 : 14}">${escapeXml(line)}</tspan>`).join("")}</text>`
    : "";
  const semantic = renderSemanticBadge(
    msg,
    Number(labelX),
    msg.y + 14,
    "middle",
    palette,
  );

  // The group is the addressable unit for review decoration: one wrapper covers
  // the arrow, its heads, the step badge, and the label. It changes no drawing
  // geometry and is independent of `data-node-id`, which stays source-derived.
  const semanticId = msg.semantics?.messageRef
    ? ` data-semantic-message-id="${escapeXml(msg.semantics.messageRef)}"`
    : msg.semantics
      ? ` data-semantic-message-name="${escapeXml(msg.semantics.name)}"`
      : "";
  return `<g class="sequence-message" data-sequence-message="${number}"${semanticId}>${line}${head}${renderSequenceBadge(msg, number, palette)}${label}${semantic}</g>`;
}

/** Size of the dog-ear fold on a note's top-right corner, in pixels. */
const NOTE_FOLD_SIZE = 14;

/**
 * Render an activation bar: a narrow box drawn over the lifeline.
 *
 * The fill is opaque so the dashed lifeline does not show through the bar,
 * which is what makes an activation read as "this participant is busy".
 */
function renderActivation(a: ActivationLayout, palette: RenderPalette): string {
  const left = a.x - ACTIVATION_WIDTH / 2;
  return `<rect x="${left.toFixed(2)}" y="${a.y.toFixed(2)}" width="${ACTIVATION_WIDTH}" height="${a.height.toFixed(2)}" fill="${palette.activationFill}" stroke="${palette.ink}" stroke-width="${STROKE_WIDTH}"${nodeIdAttribute(a.nodeId)}/>`;
}

/** Render a single note box (a rectangle with a folded top-right corner). */
function renderNote(note: NoteLayout, palette: RenderPalette): string {
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
  const box = `<path d="${body}" fill="${palette.noteFill}" stroke="${palette.noteStroke}" stroke-width="${STROKE_WIDTH}" stroke-linejoin="round"${nodeIdAttribute(note.nodeId)}/>`;

  // The fold is a small triangle filling the notch, drawn a shade darker so it
  // reads as the paper turned over.
  const foldPath =
    `M${(x + width - fold).toFixed(2)},${y.toFixed(2)} ` +
    `L${(x + width - fold).toFixed(2)},${(y + fold).toFixed(2)} ` +
    `L${(x + width).toFixed(2)},${(y + fold).toFixed(2)} Z`;
  const foldFill = `<path d="${foldPath}" fill="${palette.noteFoldFill}" stroke="${palette.noteStroke}" stroke-width="${STROKE_WIDTH}" stroke-linejoin="round"/>`;

  // Multiline notes stack one text element per line, centered vertically.
  const lines = note.labelLines ?? note.text.split("\n");
  const labelX = (x + width / 2).toFixed(2);
  const firstY =
    y + height / 2 - ((lines.length - 1) * NOTE_LINE_HEIGHT) / 2 + 4;
  const label = lines
    .map(
      (line, index) =>
        `<text x="${labelX}" y="${(firstY + index * NOTE_LINE_HEIGHT).toFixed(2)}" text-anchor="middle" font-size="12" fill="${palette.noteText}">${escapeXml(line)}</text>`,
    )
    .join("");

  return `${box}${foldFill}${label}`;
}

/**
 * Render the bullet attached to the element a note belongs to.
 *
 * The bullet is the collapsed form of the note and the control that expands it.
 * It carries `data-note-index` so the UI layer can toggle it by delegation, and
 * the usual button affordances (`role`, `tabindex`, `aria-label`) so it is
 * reachable and announced like the button it behaves as. Everything is inline
 * because the SVG is inserted as markup, not built through React.
 */
function renderNoteBullet(
  note: NoteLayout,
  index: number,
  expanded: boolean,
  palette: RenderPalette,
): string {
  const r = NOTE_BULLET_RADIUS;
  const x = note.anchorX.toFixed(2);
  const y = note.anchorY.toFixed(2);
  const label = escapeXml(note.text === "" ? "Note" : `Note: ${note.text}`);
  const ring = expanded
    ? `<circle cx="${x}" cy="${y}" r="${r + 2.5}" fill="none" stroke="${palette.noteRing}" stroke-width="1.5"/>`
    : "";
  const dot = `<circle cx="${x}" cy="${y}" r="${r}" fill="${palette.noteFill}" stroke="${palette.noteStroke}" stroke-width="1.5"/><circle cx="${x}" cy="${y}" r="2" fill="${palette.noteStroke}"/>`;
  return `<g class="note-bullet${expanded ? " note-bullet--expanded" : ""}" data-note-index="${index}" role="button" tabindex="0" aria-label="${label}" style="cursor:pointer"${nodeIdAttribute(note.nodeId)}>${ring}${dot}</g>`;
}

/**
 * Render the dashed leader from an expanded note's bullet to its callout box, so
 * the pair reads as one annotation even when the box sits beside the lifeline.
 */
function renderNoteLeader(note: NoteLayout, palette: RenderPalette): string {
  const midY = note.y + note.height / 2;
  const r = NOTE_BULLET_RADIUS;
  let x1 = note.anchorX;
  let y1 = note.anchorY;
  let x2 = note.x;
  let y2 = midY;
  switch (note.placement) {
    case "left":
      x1 = note.anchorX - r;
      x2 = note.x + note.width;
      break;
    case "right":
      x1 = note.anchorX + r;
      break;
    case "over":
    case "on":
      x1 = note.anchorX;
      y1 = note.anchorY + r;
      y2 = note.y;
      break;
  }
  return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${palette.noteStroke}" stroke-width="${STROKE_WIDTH}" stroke-dasharray="3 3"/>`;
}

/** Width of a fragment's kind tag, sized to the word it holds. */
const FRAGMENT_TAG_FONT = 11;

/**
 * Render a control-flow frame: the outer rectangle, a small tag naming the
 * fragment kind, the leading branch's label, and one divider per extra branch.
 */
function renderFragment(
  fragment: FragmentLayout,
  palette: RenderPalette,
): string {
  const { kind, label, x, y, width, height, depth, dividers } = fragment;
  const tagWidth = kind.length * 7 + 12;
  const rect = `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" rx="3" fill="none" stroke="${palette.fragmentStroke}" stroke-width="1.2"/>`;
  const tag = `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${tagWidth}" height="18" rx="3" fill="${palette.fragmentTagFill}" stroke="${palette.fragmentStroke}" stroke-width="1"/>`;
  const kindText = `<text x="${(x + 6).toFixed(2)}" y="${(y + 13).toFixed(2)}" font-size="${FRAGMENT_TAG_FONT}" font-weight="600" fill="${palette.label}">${kind}</text>`;
  const labelText = label
    ? `<text x="${(x + tagWidth + 8).toFixed(2)}" y="${(y + 13).toFixed(2)}" font-size="${FRAGMENT_TAG_FONT}" fill="${palette.label}">${escapeXml(label)}</text>`
    : "";
  const dividerMarkup = dividers
    .map((divider) => {
      const line = `<line x1="${x.toFixed(2)}" y1="${divider.y.toFixed(2)}" x2="${(x + width).toFixed(2)}" y2="${divider.y.toFixed(2)}" stroke="${palette.fragmentStroke}" stroke-width="1" stroke-dasharray="4 3"${nodeIdAttribute(divider.nodeId)}/>`;
      const text = divider.label
        ? `<text x="${(x + 8).toFixed(2)}" y="${(divider.y + 13).toFixed(2)}" font-size="${FRAGMENT_TAG_FONT}" fill="${palette.label}">${escapeXml(divider.label)}</text>`
        : "";
      return line + text;
    })
    .join("");
  return `<g class="fragment fragment--${kind}" data-fragment-kind="${kind}" data-fragment-depth="${depth}"${nodeIdAttribute(fragment.nodeId)}>${rect}${tag}${kindText}${labelText}${dividerMarkup}</g>`;
}

/** Render the diagram title, centered horizontally near the top. */
function renderTitle(layout: DiagramLayout, palette: RenderPalette): string {
  const title = layout.title ?? "";
  const x = (layout.width / 2).toFixed(2);
  const y = (TITLE_HEIGHT / 2 + 6).toFixed(2);
  return `<text x="${x}" y="${y}" text-anchor="middle" font-size="16" font-weight="600" fill="${palette.ink}">${escapeXml(title)}</text>`;
}

/**
 * Canvas size for a layout, after the renderer's minimum bounds are applied.
 *
 * Exported so the canvas size has one definition: the viewport layer needs the
 * same numbers to center and fit the diagram that the SVG document is built
 * with, and reading them back out of the markup would duplicate the rule.
 *
 * `padding` grows the canvas on every side by that many pixels; the drawing is
 * translated by the same amount, so this is the honest size of the export.
 */
export function diagramCanvasSize(
  layout: DiagramLayout,
  padding = 0,
): {
  width: number;
  height: number;
} {
  const pad = normalizePadding(padding);
  return {
    width: Math.max(MARGIN_X * 2, layout.width) + pad * 2,
    height:
      Math.max(
        PARTICIPANT_BOX_HEIGHT + (layout.title ? TITLE_HEIGHT : 0),
        layout.height,
      ) +
      pad * 2,
  };
}

/** Produce a complete SVG document string for the given layout. */
export function renderDiagramToSvg(
  layout: DiagramLayout,
  options: RenderOptions = {},
): string {
  const palette = PALETTES[options.theme === "dark" ? "dark" : "light"];
  const padding = normalizePadding(options.padding);
  const { width, height } = diagramCanvasSize(layout, padding);
  const expanded = options.expandedNotes ?? new Set<number>();
  const background = options.background ?? "white";

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">`,
  );
  // A transparent background is the absence of the rectangle, not a fill of
  // "none": rasterizers and PDF embedding then see the page's own transparency.
  if (background !== "transparent") {
    parts.push(
      `<rect width="${width}" height="${height}" fill="${escapeXml(resolveBackground(background, palette))}"/>`,
    );
  }

  // Padding is drawn as a translation of the whole drawing rather than as
  // per-coordinate arithmetic, so every element keeps its layout coordinates.
  // The group is only emitted when there is padding, which keeps the unpadded
  // document byte-identical to the one the renderer produced before this option.
  if (padding > 0) {
    parts.push(`<g transform="translate(${padding}, ${padding})">`);
  }

  if (options.includeTitle !== false && layout.title) {
    parts.push(renderTitle(layout, palette));
  }

  for (const p of layout.participants) {
    parts.push(
      p.participantType === "actor"
        ? renderActor(p, palette)
        : renderParticipant(p, palette),
    );
  }
  // Fragment frames sit behind the arrows they contain, but over the lifelines
  // so their borders stay visible.
  for (const fragment of layout.fragments ?? []) {
    parts.push(renderFragment(fragment, palette));
  }
  // Bars sit over the lifelines but below the arrows, so a message that starts
  // or ends inside an activation stays visible on top of it.
  for (const activation of layout.activations ?? []) {
    parts.push(renderActivation(activation, palette));
  }
  // Messages are numbered in source order (1-based): the array order *is* the
  // sequence, so each call and response gets the next step number.
  layout.messages.forEach((msg, index) => {
    parts.push(renderMessage(msg, index + 1, palette));
  });
  // Notes are drawn last so their callouts sit above the message band, and each
  // one is either a full box (expanded) or just its bullet.
  (layout.notes ?? []).forEach((note, index) => {
    if (expanded.has(index)) {
      parts.push(renderNoteLeader(note, palette));
      parts.push(renderNote(note, palette));
    }
    parts.push(renderNoteBullet(note, index, expanded.has(index), palette));
  });

  if (padding > 0) {
    parts.push("</g>");
  }

  parts.push("</svg>");
  return parts.join("");
}
