/**
 * Projection from the Event Flow semantic model to the row-oriented Flow view.
 *
 * This is presentation-oriented information without geometry. Keeping it here
 * means another view can consume the same EventFlow AST without inheriting the
 * row layout's coordinates or drawing assumptions.
 */
import {
  channelsOf,
  publicationsOf,
  subscriptionsOf,
  type ChannelDeclaration,
  type EventDeclaration,
  type EventFlow,
  type EventMetadataEntry,
  type EventPublication,
  type EventSubscription,
} from "./ast";
import { nodeIdOf, type AstNodeId } from "../diagram/node-id";
import type { SourceRange } from "../diagram/ast";

export const UNKNOWN_CHANNEL_KIND = "channel";

export interface FlowChannelRef {
  name: string;
  kind: string;
  broker?: string;
  nodeId: AstNodeId;
}

export interface FlowEndpoint {
  name: string;
  nodeId: AstNodeId;
  channel?: FlowChannelRef;
}

export interface FlowRow {
  event: string;
  eventNodeId: AstNodeId;
  messageRef?: string;
  description?: string;
  metadata: EventMetadataEntry[];
  producer: FlowEndpoint | null;
  consumers: FlowEndpoint[];
  declaredOnly: boolean;
  cyclic: boolean;
}

/** Semantic facts selected for the existing row-based Flow visualization. */
export interface FlowViewModel {
  title?: string;
  /** One row per event, in stable causal order. */
  rows: FlowRow[];
  /** True when causal ordering had to break a cycle. */
  cyclic: boolean;
}

/**
 * Project an Event Flow into the existing Flow view.
 *
 * Causal ordering is kept here because it decides the order of semantic event
 * rows. Layout only turns that ordered presentation into geometry.
 */
export function projectEventFlowToFlowView(flow: EventFlow): FlowViewModel {
  const declaredChannels = new Map(
    channelsOf(flow).map((channel) => [channel.name, channel]),
  );
  const declaredEvents = new Map<string, EventDeclaration>();
  const firstMention = new Map<
    string,
    {
      kind: EventPublication["type"] | EventSubscription["type"] | "event";
      range: SourceRange;
    }
  >();
  const order: string[] = [];
  const seenEvents = new Set<string>();

  for (const statement of flow.statements) {
    if (statement.type === "event") {
      if (!firstMention.has(statement.name)) {
        firstMention.set(statement.name, {
          kind: "event",
          range: statement.range,
        });
      }
      if (!declaredEvents.has(statement.name))
        declaredEvents.set(statement.name, statement);
      if (!seenEvents.has(statement.name)) {
        seenEvents.add(statement.name);
        order.push(statement.name);
      }
      continue;
    }
    if (statement.type === "publication" || statement.type === "subscription") {
      if (!firstMention.has(statement.event)) {
        firstMention.set(statement.event, {
          kind: statement.type,
          range: statement.range,
        });
      }
      if (!seenEvents.has(statement.event)) {
        seenEvents.add(statement.event);
        order.push(statement.event);
      }
    }
  }

  const publications = publicationsOf(flow);
  const subscriptions = subscriptionsOf(flow);
  const producerByEvent = new Map<string, EventPublication>();
  const consumersByEvent = new Map<string, EventSubscription[]>();
  const seenConsumers = new Map<string, Set<string>>();
  const publicationsByProducer = new Map<string, EventPublication[]>();
  const subscriptionsByConsumer = new Map<string, EventSubscription[]>();

  for (const publication of publications) {
    if (!producerByEvent.has(publication.event))
      producerByEvent.set(publication.event, publication);
    const producerPublications =
      publicationsByProducer.get(publication.producer) ?? [];
    producerPublications.push(publication);
    publicationsByProducer.set(publication.producer, producerPublications);
  }
  for (const subscription of subscriptions) {
    const eventConsumers = consumersByEvent.get(subscription.event) ?? [];
    const eventSeenConsumers =
      seenConsumers.get(subscription.event) ?? new Set<string>();
    if (!eventSeenConsumers.has(subscription.consumer)) {
      eventSeenConsumers.add(subscription.consumer);
      eventConsumers.push(subscription);
      consumersByEvent.set(subscription.event, eventConsumers);
      seenConsumers.set(subscription.event, eventSeenConsumers);
    }
    const consumerSubscriptions =
      subscriptionsByConsumer.get(subscription.consumer) ?? [];
    consumerSubscriptions.push(subscription);
    subscriptionsByConsumer.set(subscription.consumer, consumerSubscriptions);
  }

  const edges = new Map<string, Set<string>>();
  for (const [producer, producerPublications] of publicationsByProducer) {
    for (const subscription of subscriptionsByConsumer.get(producer) ?? []) {
      const targets = edges.get(subscription.event) ?? new Set<string>();
      for (const publication of producerPublications)
        targets.add(publication.event);
      edges.set(subscription.event, targets);
    }
  }

  const indegree = new Map<string, number>(order.map((name) => [name, 0]));
  for (const targets of edges.values()) {
    for (const target of targets)
      indegree.set(target, (indegree.get(target) ?? 0) + 1);
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
      if (!placed.has(target))
        indegree.set(target, (indegree.get(target) ?? 0) - 1);
    }
  }
  const residual = order.filter((name) => !placed.has(name));
  const residualNames = new Set(residual);
  const orderedNames = [...ordered, ...residual];

  return {
    title: flow.title?.value,
    rows: orderedNames.map((name) => {
      const producer = producerByEvent.get(name);
      const mention = firstMention.get(name);
      const declaration = declaredEvents.get(name);
      return {
        event: name,
        eventNodeId: declaration
          ? nodeIdOf("event", declaration.range)
          : nodeIdOf(mention?.kind ?? "event", mention?.range ?? emptyRange()),
        messageRef: declaration?.messageRef,
        description: declaration?.description,
        metadata: declaration?.metadata ?? [],
        producer: producer
          ? endpointForPublication(producer, declaredChannels)
          : null,
        consumers: (consumersByEvent.get(name) ?? []).map((subscription) =>
          endpointForSubscription(subscription, declaredChannels),
        ),
        declaredOnly: producer === undefined,
        cyclic: residualNames.has(name),
      };
    }),
    cyclic: residual.length > 0,
  };
}

function endpointForPublication(
  publication: EventPublication,
  declaredChannels: Map<string, ChannelDeclaration>,
): FlowEndpoint {
  return {
    name: publication.producer,
    nodeId: nodeIdOf("publication", publication.range),
    channel:
      publication.channel === undefined
        ? undefined
        : channelRef(publication.channel, declaredChannels, publication),
  };
}

function endpointForSubscription(
  subscription: EventSubscription,
  declaredChannels: Map<string, ChannelDeclaration>,
): FlowEndpoint {
  return {
    name: subscription.consumer,
    nodeId: nodeIdOf("subscription", subscription.range),
    channel:
      subscription.channel === undefined
        ? undefined
        : channelRef(subscription.channel, declaredChannels, subscription),
  };
}

function channelRef(
  name: string,
  declaredChannels: Map<string, ChannelDeclaration>,
  edge: EventPublication | EventSubscription,
): FlowChannelRef {
  const declaration = declaredChannels.get(name);
  return declaration
    ? {
        name,
        kind: declaration.channelKind,
        broker: declaration.broker,
        nodeId: nodeIdOf("channel", declaration.range),
      }
    : {
        name,
        kind: UNKNOWN_CHANNEL_KIND,
        nodeId: nodeIdOf(edge.type, edge.range),
      };
}

function emptyRange(): SourceRange {
  return { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
}
