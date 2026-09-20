/**
 * Event-flow layout engine.
 *
 * Pure and deterministic: given an {@link EventFlow} AST it produces an
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
  channelsOf,
  publicationsOf,
  subscriptionsOf,
  type ChannelDeclaration,
  type EventDeclaration,
  type EventFlow,
  type EventPublication,
  type EventSubscription,
  type SourceRange,
} from "../domain/eventflow/ast";
import {
  nodeIdOf,
  type AstNodeId,
  type AstNodeKind,
} from "../domain/diagram/node-id";

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

/** The channel kind used when an edge names a channel that was never declared. */
export const UNKNOWN_CHANNEL_KIND = "channel";

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
export interface EventChannelRef {
  name: string;
  kind: string;
  nodeId?: AstNodeId;
}

/**
 * One side of an event's causal relationship: the service that published it, or
 * one service that consumes it.
 */
export interface EventEndpointLayout {
  name: string;
  /**
   * The addressable node this endpoint came from: the `publishes` /
   * `consumes` statement. That is the line a click should reveal, not the
   * service declaration, which may be shared by many edges.
   */
  nodeId: AstNodeId;
  /** The channel the edge named, if it named one. */
  channel?: EventChannelRef;
}

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

/** An addressable node a row or endpoint can be traced back to. */
interface Mention {
  kind: AstNodeKind;
  range: SourceRange;
}

/**
 * Resolve one edge's channel to a {@link EventChannelRef}.
 *
 * A declared channel contributes its kind and its declaration id; an undeclared
 * one (a semantic error the validator reports) still gets a chip, labelled with
 * {@link UNKNOWN_CHANNEL_KIND} and pointing at the edge that mentioned it, so a
 * click on the chip always lands somewhere useful.
 */
function channelRef(
  name: string,
  declared: Map<string, ChannelDeclaration>,
  edge: EventPublication | EventSubscription,
): EventChannelRef {
  const declaration = declared.get(name);
  if (declaration) {
    return {
      name,
      kind: declaration.channelKind,
      nodeId: nodeIdOf("channel", declaration.range),
    };
  }
  return {
    name,
    kind: UNKNOWN_CHANNEL_KIND,
    nodeId: nodeIdOf(edge.type, edge.range),
  };
}

/**
 * Lay out an event flow AST into geometry.
 *
 * Total: a document with no statements produces an empty layout with a sane
 * canvas rather than throwing, because the editor previews every keystroke and
 * an empty document is the first thing a user has.
 */
export function layoutEventFlow(flow: EventFlow): EventFlowLayout {
  const titleHeight = flow.title ? EVENT_TITLE_HEIGHT : 0;

  const declaredChannels = new Map(
    channelsOf(flow).map((channel) => [channel.name, channel]),
  );
  const declaredEvents = new Map<string, EventDeclaration>();
  /** First appearance of each event name anywhere in the document. */
  const firstMention = new Map<string, Mention>();
  /** Event names in first-appearance order — the stable tie-break. */
  const order: string[] = [];

  for (const statement of flow.statements) {
    if (statement.type === "event") {
      if (!firstMention.has(statement.name)) {
        firstMention.set(statement.name, {
          kind: "event",
          range: statement.range,
        });
      }
      if (!declaredEvents.has(statement.name)) {
        declaredEvents.set(statement.name, statement);
      }
      if (!order.includes(statement.name)) order.push(statement.name);
      continue;
    }
    if (statement.type === "publication" || statement.type === "subscription") {
      if (!firstMention.has(statement.event)) {
        firstMention.set(statement.event, {
          kind: statement.type,
          range: statement.range,
        });
      }
      if (!order.includes(statement.event)) order.push(statement.event);
    }
  }

  // The first publication is the producer, mirroring "one row per event name".
  const producerByEvent = new Map<string, EventPublication>();
  for (const publication of publicationsOf(flow)) {
    if (!producerByEvent.has(publication.event)) {
      producerByEvent.set(publication.event, publication);
    }
  }

  // Every distinct consumer, by name, in source order.
  const consumersByEvent = new Map<string, EventSubscription[]>();
  const seenConsumers = new Map<string, Set<string>>();
  for (const subscription of subscriptionsOf(flow)) {
    let consumers = consumersByEvent.get(subscription.event);
    if (!consumers) {
      consumers = [];
      consumersByEvent.set(subscription.event, consumers);
    }
    let seen = seenConsumers.get(subscription.event);
    if (!seen) {
      seen = new Set<string>();
      seenConsumers.set(subscription.event, seen);
    }
    if (seen.has(subscription.consumer)) continue;
    seen.add(subscription.consumer);
    consumers.push(subscription);
  }

  // A causal edge A → B exists whenever one service consumes A and publishes B.
  const edges = new Map<string, Set<string>>();
  const publications = publicationsOf(flow);
  const subscriptions = subscriptionsOf(flow);
  for (const publication of publications) {
    for (const subscription of subscriptions) {
      if (subscription.consumer !== publication.producer) continue;
      let targets = edges.get(subscription.event);
      if (!targets) {
        targets = new Set<string>();
        edges.set(subscription.event, targets);
      }
      targets.add(publication.event);
    }
  }

  // Stable topological sort: repeatedly place the ready event that appears
  // earliest in the document. Whatever is left when no event is ready is a
  // cycle (or depends on one) and keeps its written order.
  const indegree = new Map<string, number>(order.map((name) => [name, 0]));
  for (const targets of edges.values()) {
    for (const target of targets) {
      indegree.set(target, (indegree.get(target) ?? 0) + 1);
    }
  }
  const placed = new Set<string>();
  const ordered: string[] = [];
  for (;;) {
    const next = order.find(
      (name) => !placed.has(name) && (indegree.get(name) ?? 0) === 0,
    );
    if (next === undefined) break;
    placed.add(next);
    ordered.push(next);
    for (const target of edges.get(next) ?? []) {
      if (placed.has(target)) continue;
      indegree.set(target, (indegree.get(target) ?? 0) - 1);
    }
  }
  const residual = order.filter((name) => !placed.has(name));
  const cyclic = residual.length > 0;
  const orderedNames = [...ordered, ...residual];
  const residualNames = new Set(residual);

  // Fixed column widths, so every row's boxes line up under the one above.
  let producerColumnWidth = 0;
  let channelColumnWidth = 0;
  let eventColumnWidth = EVENT_MIN_EVENT_WIDTH;
  let consumerColumnWidth = 0;
  for (const name of orderedNames) {
    const producer = producerByEvent.get(name);
    producerColumnWidth = Math.max(
      producerColumnWidth,
      producer ? serviceBoxWidth(producer.producer) : noProducerWidth(),
    );
    if (producer?.channel !== undefined) {
      channelColumnWidth = Math.max(
        channelColumnWidth,
        channelChipWidth(producer.channel),
      );
    }
    eventColumnWidth = Math.max(eventColumnWidth, eventBoxWidth(name));
    for (const subscription of consumersByEvent.get(name) ?? []) {
      consumerColumnWidth = Math.max(
        consumerColumnWidth,
        serviceBoxWidth(subscription.consumer),
      );
    }
  }

  // The cycle tag owns a left-hand column, but only when one is needed, so an
  // acyclic document keeps the full margin.
  const left = EVENT_MARGIN_X + (cyclic ? EVENT_CYCLE_TAG_WIDTH : 0);
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

  for (const name of orderedNames) {
    const producer = producerByEvent.get(name);
    const subscriptionsForEvent = consumersByEvent.get(name) ?? [];
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

    const declaration = declaredEvents.get(name);
    const mention = firstMention.get(name);
    const eventNodeId = declaration
      ? nodeIdOf("event", declaration.range)
      : nodeIdOf(mention?.kind ?? "event", mention?.range ?? emptyRange());

    rows.push({
      event: name,
      eventNodeId,
      y: cursorY,
      height,
      producer: producer
        ? {
            name: producer.producer,
            nodeId: nodeIdOf("publication", producer.range),
            channel:
              producer.channel === undefined
                ? undefined
                : channelRef(producer.channel, declaredChannels, producer),
          }
        : null,
      consumers: subscriptionsForEvent.map((subscription) => ({
        name: subscription.consumer,
        nodeId: nodeIdOf("subscription", subscription.range),
        channel:
          subscription.channel === undefined
            ? undefined
            : channelRef(subscription.channel, declaredChannels, subscription),
      })),
      declaredOnly: producer === undefined,
      cyclic: residualNames.has(name),
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
              width: channelChipWidth(producer.channel),
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
    title: flow.title ? flow.title.value : undefined,
    rows,
    cyclic,
  };
}

/** A zero-width range at the document origin, for a mention that cannot exist. */
function emptyRange(): SourceRange {
  return { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
}
