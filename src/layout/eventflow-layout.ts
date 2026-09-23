/**
 * Event-flow layout engine.
 *
 * Pure and deterministic: given a {@link FlowViewModel} it produces an
 * {@link EventFlowLayout}. It knows nothing about SVG or the DOM — it only
 * computes coordinates. The renderer consumes this layout.
 *
 * The picture is **one row per event**, which is what makes an event-driven
 * design legible: a sequence diagram answers "in what order do these calls
 * happen", while an event flow answers "who produces this event, and who reacts
 * to it". Each row therefore reads left to right as producer → channel → event,
 * and then fans out down the right-hand side to one arrow per consumer.
 *
 * Layout rules:
 * - There is one row per event *name*, never per declaration or publication: a
 *   name that is declared twice, or published twice, is still one event. The
 *   first publication is the row's producer and the first subscription per
 *   consumer name is its consumer, both in source order.
 * - An event that nothing publishes is still a row, with `producer: null` and
 *   `declaredOnly: true`, so a half-written document remains readable.
 * - Row height grows with the number of consumers, so a fan-out never
 *   overlaps; the event box stays vertically centered on the row.
 * - The canvas widens to fit the widest producer, channel chip, event box and
 *   consumer in their own aligned columns, plus the margins.
 *
 * Causal ordering rule (the reason this module exists):
 * 1. A row exists for every event name the document declares, publishes or
 *    subscribes to, in first-appearance order.
 * 2. There is an edge `A → B` whenever one service consumes `A` and publishes
 *    `B`; the edge set is de-duplicated.
 * 3. Rows are emitted by a *stable* topological sort of those edges: at every
 *    step, of the events with no unplaced predecessor, the one that appears
 *    earliest in the document is placed first. The same document therefore
 *    always lays out identically, and a document with no causal information
 *    keeps its written order.
 * 4. When a cycle leaves events with no ready predecessor, the remaining events
 *    are appended in first-appearance order and {@link EventFlowLayout.cyclic}
 *    is set (the affected rows carry {@link EventRowLayout.cyclic}), so the
 *    renderer can say so instead of pretending the order is causal.
 */
import {
  type FlowChannelRef,
  type FlowEndpoint,
  type FlowViewModel,
} from "../domain/eventflow/flow-projection";
import type { AstNodeId } from "../domain/diagram/node-id";

export { UNKNOWN_CHANNEL_KIND } from "../domain/eventflow/flow-projection";

/** Horizontal margin around the widest row. */
export const EVENT_MARGIN_X = 24;

/** Vertical margin above the first row and below the last. */
export const EVENT_MARGIN_Y = 16;

/** Vertical space reserved at the top for the title, or 0 if there is none. */
export const EVENT_TITLE_HEIGHT = 28;

/** Height of an event box. */
export const EVENT_BOX_HEIGHT = 28;

/** Vertical distance between consecutive rows. */
export const EVENT_ROW_GAP = 16;

/** Horizontal distance between the producer, channel, event and consumer columns. */
export const EVENT_COLUMN_GAP = 32;

/** Height of a producer / consumer service box. */
export const EVENT_SERVICE_BOX_HEIGHT = 26;

/** Height of one consumer box in a fan-out. */
export const EVENT_CONSUMER_BOX_HEIGHT = 24;

/** Vertical distance between stacked consumer boxes in one row. */
export const EVENT_CONSUMER_GAP = 8;

/** Height of the channel chip drawn on the producer → event path. */
export const EVENT_CHANNEL_CHIP_HEIGHT = 20;

/** Horizontal padding inside a channel chip. */
export const EVENT_CHANNEL_CHIP_PADDING_X = 8;

/** Minimum width of an event box. */
export const EVENT_MIN_EVENT_WIDTH = 120;

/** Minimum width of a producer service box. */
export const EVENT_MIN_SERVICE_WIDTH = 84;

/** Minimum width of a consumer service box. */
export const EVENT_MIN_CONSUMER_WIDTH = 84;

/**
 * Width of the left-hand column reserved for a row's cycle tag, but only when
 * the causal ordering had to break a cycle. Reserving it in the layout (rather
 * than drawing the tag over the drawing) guarantees the tag never covers the
 * producer cell.
 */
export const EVENT_CYCLE_TAG_WIDTH = 44;

/** Height of the cycle tag drawn on a row that could not be ordered causally. */
export const EVENT_CYCLE_TAG_HEIGHT = 16;

/** Width of the fan-out arrowhead triangle, in pixels. */
export const EVENT_ARROW_HEAD_SIZE = 8;

/** Height of the fan-out arrowhead triangle, in pixels. */
export const EVENT_ARROW_HEAD_HEIGHT = 10;

/**
 * The faint label shown where a producer would be when nothing publishes the
 * event. Exported so the layout can reserve room for it and the renderer draws
 * the identical text.
 */
export const NO_PRODUCER_LABEL = "(no producer)";

/** Rectangular geometry shared by everything the renderer draws in a row. */
export interface EventBoxGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A channel an edge travels through.
 *
 * `kind` is the declared channel kind (`topic` / `queue` / `stream`), or
 * {@link UNKNOWN_CHANNEL_KIND} when the edge names a channel the document never
 * declared. `nodeId` points at the channel declaration when there is one, and
 * otherwise at the edge statement that mentioned it, so the chip is always
 * traceable back to source.
 */
export type EventChannelRef = FlowChannelRef;

/**
 * One side of an event's causal relationship: the service that published it, or
 * one service that consumes it.
 */
export type EventEndpointLayout = FlowEndpoint;

/** Geometry of the channel chip, when a row has one. */
export interface EventChannelChipLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One event's row: the producer → channel → event path on the left, the event
 * box in the middle, and the fan-out to every consumer on the right.
 */
export interface EventRowLayout {
  event: string;
  /** Id of the event declaration node, so a click maps back to a statement. */
  eventNodeId: AstNodeId;
  /** Top edge of the row's band. */
  y: number;
  /** Height of the row's band, grown to fit the consumer stack. */
  height: number;
  /** The publication that produced it, or null when nothing publishes it. */
  producer: EventEndpointLayout | null;
  /** One entry per consumer, top to bottom — this *is* the fan-out. */
  consumers: EventEndpointLayout[];
  /** Whether the row shows a declared-but-unproduced event (drawn dashed). */
  declaredOnly: boolean;
  /**
   * Whether the causal ordering had to break a cycle to place this row. Set on
   * every event left over after the topological sort, which includes the events
   * in the cycle and the events that depend on them; the renderer marks these
   * rows instead of implying an order that does not exist. Optional so
   * hand-built layouts (mostly in tests) remain valid.
   */
  cyclic?: boolean;
  /** Box of the event itself, vertically centered in the row. */
  eventBox: EventBoxGeometry;
  /** Box of the producing service, or null on a declared-only row. */
  producerBox: EventBoxGeometry | null;
  /**
   * The producer column's cell for this row. Always present, so the renderer has
   * somewhere to put the {@link NO_PRODUCER_LABEL} when `producerBox` is null.
   */
  producerCell: EventBoxGeometry;
  /** Geometry of the channel chip, or null when the row has no channel. */
  channelChip: EventChannelChipLayout | null;
  /** One box per entry in {@link consumers}, in the same order, top to bottom. */
  consumerBoxes: EventBoxGeometry[];
}

/** The full geometric description of an event flow, ready to be rendered. */
export interface EventFlowLayout {
  width: number;
  height: number;
  /** The flow title text, or undefined when the document has none. */
  title?: string;
  /** One row per event, in causal order. */
  rows: EventRowLayout[];
  /** True when the causal ordering had to break a cycle (see the module doc). */
  cyclic: boolean;
}

/** Estimate the pixel width of a label using an average character width. */
function estimateLabelWidth(label: string): number {
  if (label.length === 0) return EVENT_MARGIN_X;
  // ~7px per character is a reasonable average for a monospace-ish estimate.
  return Math.max(EVENT_MARGIN_X, label.length * 7 + 8);
}

/** Width of the box drawn around a service name. */
function serviceBoxWidth(name: string): number {
  return Math.max(EVENT_MIN_SERVICE_WIDTH, estimateLabelWidth(name) + 16);
}

/** Width of the box drawn around an event name. */
function eventBoxWidth(name: string): number {
  return Math.max(EVENT_MIN_EVENT_WIDTH, estimateLabelWidth(name) + 16);
}

/** Width of the channel chip drawn for a channel name. */
function channelChipWidth(name: string): number {
  return estimateLabelWidth(name) + EVENT_CHANNEL_CHIP_PADDING_X * 2;
}

/** Width the producer column must reserve for the {@link NO_PRODUCER_LABEL}. */
function noProducerWidth(): number {
  return Math.max(
    EVENT_MIN_SERVICE_WIDTH,
    estimateLabelWidth(NO_PRODUCER_LABEL),
  );
}

/**
 * Lay out a Flow view model into geometry.
 *
 * Total: a document with no statements produces an empty layout with a sane
 * canvas rather than throwing, because the editor previews every keystroke and
 * an empty document is the first thing a user has.
 */
export function layoutEventFlow(flow: FlowViewModel): EventFlowLayout {
  const titleHeight = flow.title ? EVENT_TITLE_HEIGHT : 0;
  const orderedNames = flow.rows.map((row) => row.event);

  // Fixed column widths, so every row's boxes line up under the one above.
  let producerColumnWidth = 0;
  let channelColumnWidth = 0;
  let eventColumnWidth = EVENT_MIN_EVENT_WIDTH;
  let consumerColumnWidth = 0;
  for (const row of flow.rows) {
    const name = row.event;
    const producer = row.producer;
    producerColumnWidth = Math.max(
      producerColumnWidth,
      producer ? serviceBoxWidth(producer.name) : noProducerWidth(),
    );
    if (producer?.channel !== undefined) {
      channelColumnWidth = Math.max(
        channelColumnWidth,
        channelChipWidth(producer.channel.name),
      );
    }
    eventColumnWidth = Math.max(eventColumnWidth, eventBoxWidth(name));
    for (const consumer of row.consumers) {
      consumerColumnWidth = Math.max(
        consumerColumnWidth,
        serviceBoxWidth(consumer.name),
      );
    }
  }

  // The cycle tag owns a left-hand column, but only when one is needed, so an
  // acyclic document keeps the full margin.
  const left = EVENT_MARGIN_X + (flow.cyclic ? EVENT_CYCLE_TAG_WIDTH : 0);
  const producerX = left;
  const channelX = producerX + producerColumnWidth + EVENT_COLUMN_GAP;
  const eventX =
    channelX +
    (channelColumnWidth > 0 ? channelColumnWidth + EVENT_COLUMN_GAP : 0);
  const consumersX = eventX + eventColumnWidth + EVENT_COLUMN_GAP;
  const rightEdge =
    consumerColumnWidth > 0
      ? consumersX + consumerColumnWidth
      : eventX + eventColumnWidth;

  const rows: EventRowLayout[] = [];
  /** Top edge of the next row. */
  let cursorY = titleHeight + EVENT_MARGIN_Y;

  for (const row of flow.rows) {
    const name = row.event;
    const producer = row.producer;
    const subscriptionsForEvent = row.consumers;
    const stackHeight =
      subscriptionsForEvent.length === 0
        ? 0
        : subscriptionsForEvent.length * EVENT_CONSUMER_BOX_HEIGHT +
          (subscriptionsForEvent.length - 1) * EVENT_CONSUMER_GAP;
    const height = Math.max(EVENT_BOX_HEIGHT, stackHeight);
    const centerY = cursorY + height / 2;

    // Consumers stack top to bottom inside the row, centered as a group, so the
    // fan-out never overlaps however many consumers an event has.
    const stackTop = cursorY + (height - stackHeight) / 2;

    rows.push({
      event: name,
      eventNodeId: row.eventNodeId,
      y: cursorY,
      height,
      producer: producer
        ? {
            name: producer.name,
            nodeId: producer.nodeId,
            channel: producer.channel,
          }
        : null,
      consumers: subscriptionsForEvent.map((consumer) => ({
        name: consumer.name,
        nodeId: consumer.nodeId,
        channel: consumer.channel,
      })),
      declaredOnly: row.declaredOnly,
      cyclic: row.cyclic,
      eventBox: {
        x: eventX,
        y: centerY - EVENT_BOX_HEIGHT / 2,
        width: eventColumnWidth,
        height: EVENT_BOX_HEIGHT,
      },
      producerBox: producer
        ? {
            x: producerX,
            y: centerY - EVENT_SERVICE_BOX_HEIGHT / 2,
            width: producerColumnWidth,
            height: EVENT_SERVICE_BOX_HEIGHT,
          }
        : null,
      producerCell: {
        x: producerX,
        y: cursorY,
        width: producerColumnWidth,
        height,
      },
      channelChip:
        producer?.channel === undefined
          ? null
          : {
              x: channelX,
              y: centerY - EVENT_CHANNEL_CHIP_HEIGHT / 2,
              width: channelChipWidth(producer.channel.name),
              height: EVENT_CHANNEL_CHIP_HEIGHT,
            },
      consumerBoxes: subscriptionsForEvent.map((_, index) => ({
        x: consumersX,
        y: stackTop + index * (EVENT_CONSUMER_BOX_HEIGHT + EVENT_CONSUMER_GAP),
        width: consumerColumnWidth,
        height: EVENT_CONSUMER_BOX_HEIGHT,
      })),
    });

    cursorY += height + EVENT_ROW_GAP;
  }

  return {
    width:
      orderedNames.length === 0
        ? EVENT_MARGIN_X * 2
        : rightEdge + EVENT_MARGIN_X,
    height:
      orderedNames.length === 0
        ? titleHeight + EVENT_MARGIN_Y * 2
        : cursorY - EVENT_ROW_GAP + EVENT_MARGIN_Y,
    title: flow.title,
    rows,
    cyclic: flow.cyclic,
  };
}
