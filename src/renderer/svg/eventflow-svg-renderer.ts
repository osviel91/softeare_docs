/**
 * SVG renderer for event flows.
 *
 * Pure and deterministic: given an {@link EventFlowLayout} it produces an SVG
 * string. The renderer never parses source text (Rule 1) — it only consumes the
 * layout produced by the layout engine. All drawing decisions live here, so the
 * layout engine stays free of any SVG concerns.
 *
 * The picture is one row per event: a producer box and its channel chip on the
 * left, the event box in the middle, and one arrow per consumer fanning out to
 * the right. Every addressable thing (producer, channel, event, consumer) emits
 * `data-node-id`, which is what makes click-to-source work exactly as it does in
 * the sequence renderer.
 *
 * Colour is the one exception to "the layout decides everything": a theme is a
 * presentation choice the same drawing can be rendered under, so it is threaded
 * through here as {@link EventFlowRenderOptions.theme} rather than baked into
 * geometry.
 */
import {
  EVENT_ARROW_HEAD_HEIGHT,
  EVENT_ARROW_HEAD_SIZE,
  EVENT_CHANNEL_CHIP_HEIGHT,
  EVENT_CYCLE_TAG_HEIGHT,
  EVENT_CYCLE_TAG_WIDTH,
  EVENT_MARGIN_X,
  EVENT_TITLE_HEIGHT,
  NO_PRODUCER_LABEL,
  type EventBoxGeometry,
  type EventChannelChipLayout,
  type EventEndpointLayout,
  type EventFlowLayout,
  type EventRowLayout,
} from "../../layout/eventflow-layout";

/** The colour schemes the renderer knows how to draw. */
export type EventFlowRenderTheme = "light" | "dark";

/** Options that change what the renderer draws without changing the layout. */
export interface EventFlowRenderOptions {
  /**
   * Colour scheme. Defaults to `"light"`, so a caller that passes no theme gets
   * the light drawing.
   */
  theme?: EventFlowRenderTheme;
  /**
   * Canvas fill: `"white"` (the default) means the theme's paper — white under
   * the light theme, the dark paper under the dark one — `"transparent"` omits
   * the background rectangle entirely, and any other value is used verbatim as a
   * CSS colour.
   */
  background?: string;
  /**
   * Whether to draw the flow title when the layout carries one. Defaults to
   * true; `false` drops the title element without changing the canvas size (the
   * layout already reserved room for it).
   */
  includeTitle?: boolean;
  /** Extra padding around the drawing, in px. Defaults to 0. */
  padding?: number;
}

/**
 * Every colour the renderer draws with, for one theme.
 *
 * Centralising the palette is what lets a theme be a single lookup instead of a
 * scatter of conditionals, exactly as the sequence renderer does it.
 */
interface EventFlowPalette {
  /** Fill of the full-canvas background rectangle. */
  canvas: string;
  /** Fill of a producer / consumer service box. */
  serviceFill: string;
  /** Fill of an event box. */
  eventFill: string;
  /** Fill of a channel chip. */
  channelFill: string;
  /** Channel chip text. */
  channelText: string;
  /** Slate stroke: the fan-out and producer-path lines, and box outlines. */
  line: string;
  /** Primary ink: box outlines, event names and the title. */
  ink: string;
  /** Muted ink: service names. */
  label: string;
  /** Fill of every arrowhead. */
  arrow: string;
  /** Fill of the cycle tag. */
  cycleFill: string;
  /** Stroke and text of the cycle tag. */
  cycleText: string;
  /** Faint ink of the "no producer" label. */
  noProducer: string;
}

/** The palette per theme. Light is the default. */
const PALETTES: Record<EventFlowRenderTheme, EventFlowPalette> = {
  light: {
    canvas: "#ffffff",
    serviceFill: "#eef2f7",
    eventFill: "#f8fafc",
    channelFill: "#e2e8f0",
    channelText: "#334155",
    line: "#94a3b8",
    ink: "#0f172a",
    label: "#334155",
    arrow: "#0f172a",
    cycleFill: "#fee2e2",
    cycleText: "#b91c1c",
    noProducer: "#94a3b8",
  },
  dark: {
    canvas: "#0f172a",
    serviceFill: "#1e293b",
    eventFill: "#1e293b",
    channelFill: "#334155",
    channelText: "#cbd5e1",
    line: "#94a3b8",
    ink: "#e2e8f0",
    label: "#cbd5e1",
    arrow: "#e2e8f0",
    cycleFill: "#7f1d1d",
    cycleText: "#fecaca",
    noProducer: "#64748b",
  },
};

/** Stroke width used for every line and box outline. */
const STROKE_WIDTH = 1.5;

/** Dashes used for the outline of a declared-but-unproduced event. */
const DECLARED_ONLY_DASHES = "5 4";

/** The word drawn inside a row's cycle tag. */
const CYCLE_TAG_LABEL = "cycle";

/**
 * Escape text for safe inclusion inside SVG text elements.
 *
 * Deliberately a local copy of the sequence renderer's function rather than an
 * import: the renderer must stay independent of the sequence module so an
 * event-flow document can be rendered without loading — or being broken by — the
 * sequence pipeline. The behaviour is identical: the four characters that can
 * end a text node or an attribute are replaced.
 */
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
 * Hand-built layouts (mostly in tests) may omit ids, so every emission is
 * conditional.
 */
function nodeIdAttribute(nodeId: string | undefined): string {
  return nodeId === undefined ? "" : ` data-node-id="${escapeXml(nodeId)}"`;
}

/**
 * The drawing padding, clamped to a finite non-negative number.
 *
 * A missing, negative, or non-finite value means "no padding", which keeps a bad
 * value from producing a canvas with a negative width.
 */
function normalizePadding(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

/** Resolve the canvas fill keyword for a theme. */
function resolveBackground(
  background: string,
  palette: EventFlowPalette,
): string {
  // "white" is a keyword for the theme's paper, not a literal colour, so a dark
  // flow is dark by default. Pin a literal white with "#ffffff".
  return background === "white" ? palette.canvas : background;
}

/** A rounded rectangle outline, with an optional dash pattern and node id. */
function boxRect(
  box: EventBoxGeometry,
  className: string,
  fill: string,
  stroke: string,
  nodeId?: string,
  dashed = false,
): string {
  const dashes = dashed ? ` stroke-dasharray="${DECLARED_ONLY_DASHES}"` : "";
  return `<rect class="${className}" x="${box.x.toFixed(2)}" y="${box.y.toFixed(2)}" width="${box.width.toFixed(2)}" height="${box.height.toFixed(2)}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="${STROKE_WIDTH}"${dashes}${nodeIdAttribute(nodeId)}/>`;
}

/** Centered text inside a box, at the given font size and weight. */
function boxText(
  box: EventBoxGeometry,
  text: string,
  fontSize: number,
  fill: string,
  weight = "500",
): string {
  return `<text x="${(box.x + box.width / 2).toFixed(2)}" y="${(box.y + box.height / 2 + 4).toFixed(2)}" text-anchor="middle" font-size="${fontSize}" font-weight="${weight}" fill="${fill}">${escapeXml(text)}</text>`;
}

/** A horizontal connector line. */
function edgeLine(
  x1: number,
  x2: number,
  y: number,
  palette: EventFlowPalette,
): string {
  return `<line class="eventflow-edge" x1="${x1.toFixed(2)}" y1="${y.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y.toFixed(2)}" stroke="${palette.line}" stroke-width="${STROKE_WIDTH}"/>`;
}

/** A right-pointing filled arrowhead with its tip at (`tipX`, `tipY`). */
function arrowHead(
  tipX: number,
  tipY: number,
  palette: EventFlowPalette,
): string {
  const baseX = tipX - EVENT_ARROW_HEAD_SIZE;
  const half = EVENT_ARROW_HEAD_HEIGHT / 2;
  return `<polygon class="eventflow-arrow" points="${tipX.toFixed(2)},${tipY.toFixed(2)} ${baseX.toFixed(2)},${(tipY - half).toFixed(2)} ${baseX.toFixed(2)},${(tipY + half).toFixed(2)}" fill="${palette.arrow}"/>`;
}

/** Render the flow title, centered horizontally near the top. */
function renderTitle(
  layout: EventFlowLayout,
  palette: EventFlowPalette,
): string {
  const x = (layout.width / 2).toFixed(2);
  const y = (EVENT_TITLE_HEIGHT / 2 + 6).toFixed(2);
  return `<text class="eventflow-title" x="${x}" y="${y}" text-anchor="middle" font-size="16" font-weight="600" fill="${palette.ink}">${escapeXml(layout.title ?? "")}</text>`;
}

/**
 * Render the small tag that says a row's position is not causal.
 *
 * It sits in the left-hand column the layout reserved for it whenever a cycle
 * was broken, so it never covers the producer box.
 */
function renderCycleTag(
  row: EventRowLayout,
  palette: EventFlowPalette,
): string {
  const width = EVENT_CYCLE_TAG_WIDTH - 8;
  const x = EVENT_MARGIN_X + 2;
  const y = row.y + (row.height - EVENT_CYCLE_TAG_HEIGHT) / 2;
  const rect = `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width}" height="${EVENT_CYCLE_TAG_HEIGHT}" rx="3" fill="${palette.cycleFill}" stroke="${palette.cycleText}" stroke-width="1"/>`;
  const text = `<text x="${(x + width / 2).toFixed(2)}" y="${(y + EVENT_CYCLE_TAG_HEIGHT / 2 + 3.5).toFixed(2)}" text-anchor="middle" font-size="10" font-weight="600" fill="${palette.cycleText}">${CYCLE_TAG_LABEL}</text>`;
  return `<g class="eventflow-cycle-tag" data-row-event="${escapeXml(row.event)}">${rect}${text}</g>`;
}

/**
 * Render the producer cell of a row nothing publishes.
 *
 * A faint label rather than an empty gap: the reader must be able to tell "no
 * producer" apart from "the producer was not drawn".
 */
function renderNoProducer(
  row: EventRowLayout,
  palette: EventFlowPalette,
): string {
  const cell = row.producerCell;
  return `<text class="eventflow-no-producer" x="${(cell.x + cell.width / 2).toFixed(2)}" y="${(cell.y + cell.height / 2 + 3.5).toFixed(2)}" text-anchor="middle" font-size="10" font-style="italic" fill="${palette.noProducer}">${escapeXml(NO_PRODUCER_LABEL)}</text>`;
}

/**
 * Render the producer → channel → event path on the left of a row.
 *
 * The chip is drawn only when the producing edge named a channel; the arrowhead
 * always lands on the event box's left edge, so the reading order "produced,
 * carried, became" survives a missing channel.
 */
function renderProducerPath(
  row: EventRowLayout,
  palette: EventFlowPalette,
): string {
  const producer = row.producer;
  const box = row.producerBox;
  if (!producer || !box) return renderNoProducer(row, palette);

  const y = box.y + box.height / 2;
  const boxRight = box.x + box.width;
  const eventLeft = row.eventBox.x;
  const chip = row.channelChip;
  const parts: string[] = [];

  parts.push(
    `<g class="eventflow-producer" data-service-name="${escapeXml(producer.name)}">` +
      boxRect(
        box,
        "eventflow-service eventflow-service--producer",
        palette.serviceFill,
        palette.line,
        producer.nodeId,
      ) +
      boxText(box, producer.name, 12, palette.ink) +
      "</g>",
  );

  if (chip && producer.channel) {
    parts.push(edgeLine(boxRight, chip.x, y, palette));
    parts.push(renderChannelChip(chip, producer, palette));
    parts.push(edgeLine(chip.x + chip.width, eventLeft, y, palette));
  } else {
    parts.push(edgeLine(boxRight, eventLeft, y, palette));
  }
  parts.push(arrowHead(eventLeft, y, palette));
  return parts.join("");
}

/** Render one channel chip and its text. */
function renderChannelChip(
  chip: EventChannelChipLayout,
  producer: EventEndpointLayout,
  palette: EventFlowPalette,
): string {
  const channel = producer.channel;
  const name = channel ? channel.name : "";
  const kind = channel ? channel.kind : "";
  const rect = `<rect class="eventflow-channel-chip" x="${chip.x.toFixed(2)}" y="${chip.y.toFixed(2)}" width="${chip.width.toFixed(2)}" height="${chip.height.toFixed(2)}" rx="9" fill="${palette.channelFill}" stroke="${palette.line}" stroke-width="1"${nodeIdAttribute(channel?.nodeId)}/>`;
  const text = `<text x="${(chip.x + chip.width / 2).toFixed(2)}" y="${(chip.y + EVENT_CHANNEL_CHIP_HEIGHT / 2 + 4).toFixed(2)}" text-anchor="middle" font-size="11" fill="${palette.channelText}">${escapeXml(name)}</text>`;
  return `<g class="eventflow-channel" data-channel-name="${escapeXml(name)}" data-channel-kind="${escapeXml(kind)}">${rect}${text}</g>`;
}

/** Render the event box: dashed when nothing publishes the event. */
function renderEventBox(
  row: EventRowLayout,
  palette: EventFlowPalette,
): string {
  const className = row.declaredOnly
    ? "eventflow-event eventflow-event--declared-only"
    : "eventflow-event";
  const semantic = row.messageRef
    ? ` data-semantic-message-id="${escapeXml(row.messageRef)}" tabindex="0" role="button" aria-label="Inspect semantic message ${escapeXml(row.event)}"`
    : ` data-semantic-message-name="${escapeXml(row.event)}" tabindex="0" role="button" aria-label="Inspect unbound semantic message ${escapeXml(row.event)}"`;
  return (
    `<g${nodeIdAttribute(row.eventNodeId)}${semantic}>${boxRect(
      row.eventBox,
      className,
      palette.eventFill,
      palette.ink,
      undefined,
      row.declaredOnly,
    )}${boxText(row.eventBox, row.event, 12, palette.ink, "600")}</g>`
  );
}

/**
 * Render one fan-out branch from the shared spine to this consumer's box,
 * ending in an arrowhead.
 *
 * One line per consumer (never one line with a count) is what makes the fan-out
 * explicit. The line leaves the event box at the consumer's own height, so the
 * edges spread apart instead of crossing.
 */
function renderFanout(
  consumer: EventEndpointLayout,
  box: EventBoxGeometry,
  spineX: number,
  palette: EventFlowPalette,
): string {
  const y = box.y + box.height / 2;
  const channelAttribute =
    consumer.channel === undefined
      ? ""
      : ` data-channel="${escapeXml(consumer.channel.name)}" data-channel-kind="${escapeXml(consumer.channel.kind)}"`;
  const line = `<line class="fanout-edge" data-eventflow-edge="consumer" x1="${spineX.toFixed(2)}" y1="${y.toFixed(2)}" x2="${box.x.toFixed(2)}" y2="${y.toFixed(2)}" stroke="${palette.line}" stroke-width="${STROKE_WIDTH}"/>`;
  const rect = boxRect(
    box,
    "eventflow-service eventflow-service--consumer",
    palette.serviceFill,
    palette.line,
    consumer.nodeId,
  );
  const text = boxText(box, consumer.name, 11, palette.label);
  return `<g class="eventflow-consumer" data-service-name="${escapeXml(consumer.name)}"${channelAttribute}>${line}${arrowHead(box.x, y, palette)}${rect}${text}</g>`;
}

/** Render the event-to-consumer trunk, spine, and its individual branches. */
function renderFanoutConnectors(
  row: EventRowLayout,
  palette: EventFlowPalette,
): string {
  const endpoints = row.consumers.flatMap((consumer, index) => {
    const box = row.consumerBoxes[index];
    return box ? [{ consumer, box }] : [];
  });
  if (endpoints.length === 0) return "";

  const eventRight = row.eventBox.x + row.eventBox.width;
  const eventCenterY = row.eventBox.y + row.eventBox.height / 2;
  const spineX = (eventRight + endpoints[0].box.x) / 2;
  const centers = endpoints.map(({ box }) => box.y + box.height / 2);
  const parts = [
    `<line class="fanout-trunk" x1="${eventRight.toFixed(2)}" y1="${eventCenterY.toFixed(2)}" x2="${spineX.toFixed(2)}" y2="${eventCenterY.toFixed(2)}" stroke="${palette.line}" stroke-width="${STROKE_WIDTH}"/>`,
  ];
  if (centers.length > 1) {
    parts.push(
      `<line class="fanout-spine" x1="${spineX.toFixed(2)}" y1="${Math.min(...centers).toFixed(2)}" x2="${spineX.toFixed(2)}" y2="${Math.max(...centers).toFixed(2)}" stroke="${palette.line}" stroke-width="${STROKE_WIDTH}"/>`,
    );
  }
  endpoints.forEach(({ consumer, box }) =>
    parts.push(renderFanout(consumer, box, spineX, palette)),
  );
  return parts.join("");
}

/** Render one event row: cycle tag, producer path, event box, then the fan-out. */
function renderRow(
  row: EventRowLayout,
  layoutCyclic: boolean,
  palette: EventFlowPalette,
): string {
  const parts: string[] = [];
  // A hand-built layout may carry only the layout-level flag; fall back to it so
  // a cycle is never silently hidden.
  if (row.cyclic ?? layoutCyclic) parts.push(renderCycleTag(row, palette));
  parts.push(renderProducerPath(row, palette));
  parts.push(renderEventBox(row, palette));
  parts.push(renderFanoutConnectors(row, palette));
  return `<g class="eventflow-row" data-event="${escapeXml(row.event)}">${parts.join("")}</g>`;
}

/**
 * Canvas size for a layout, after the renderer's minimum bounds are applied.
 *
 * Exported so the canvas size has one definition: the viewport layer needs the
 * same numbers to center and fit the flow that the SVG document is built with.
 *
 * `padding` grows the canvas on every side by that many pixels; the drawing is
 * translated by the same amount, so this is the honest size of the export.
 */
export function eventFlowCanvasSize(
  layout: EventFlowLayout,
  padding = 0,
): { width: number; height: number } {
  const pad = normalizePadding(padding);
  return {
    width: Math.max(EVENT_MARGIN_X * 2, layout.width) + pad * 2,
    height: Math.max(EVENT_MARGIN_X * 2, layout.height) + pad * 2,
  };
}

/** Produce a complete SVG document string for the given layout. */
export function renderEventFlowToSvg(
  layout: EventFlowLayout,
  options: EventFlowRenderOptions = {},
): string {
  const palette = PALETTES[options.theme === "dark" ? "dark" : "light"];
  const padding = normalizePadding(options.padding);
  const { width, height } = eventFlowCanvasSize(layout, padding);
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
  if (padding > 0) {
    parts.push(`<g transform="translate(${padding}, ${padding})">`);
  }

  if (options.includeTitle !== false && layout.title) {
    parts.push(renderTitle(layout, palette));
  }

  for (const row of layout.rows) {
    parts.push(renderRow(row, layout.cyclic, palette));
  }

  if (padding > 0) {
    parts.push("</g>");
  }

  parts.push("</svg>");
  return parts.join("");
}
