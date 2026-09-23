/** Independent service-topology projection of the Event Flow semantic model. */
import {
  channelsOf,
  servicesOf,
  type ChannelDeclaration,
  type EventFlow,
  type EventMetadataEntry,
  type EventPublication,
  type EventSubscription,
  type ServiceRole,
} from "./ast";
import { nodeIdOf, type AstNodeId } from "../diagram/node-id";

export interface TopologyChannel {
  name: string;
  kind: string;
  broker?: string;
  nodeId: AstNodeId;
}

export interface TopologyService {
  name: string;
  role: ServiceRole;
  nodeId: AstNodeId;
}

export interface TopologyEvent {
  name: string;
  description?: string;
  metadata: EventMetadataEntry[];
  /** All source relationships represented by this aggregate event. */
  publicationNodeIds: AstNodeId[];
  subscriptionNodeIds: AstNodeId[];
  channels: TopologyChannel[];
}

export interface TopologyConnection {
  /** Stable aggregate identity, derived from the two service names. */
  id: string;
  producer: string;
  consumer: string;
  events: TopologyEvent[];
  /** Explicitly all source nodes behind the aggregate, never a fake AST node. */
  sourceNodeIds: AstNodeId[];
}

export interface TopologyViewModel {
  title?: string;
  services: TopologyService[];
  connections: TopologyConnection[];
}

interface Relationship {
  event: string;
  nodeId: AstNodeId;
  channel?: TopologyChannel;
}

/**
 * Project publications and subscriptions directly into a mediated event graph.
 * A connection means "the producer's event is consumed by the consumer", not a
 * synchronous call. Events are grouped per service pair to keep the graph small.
 */
export function projectEventFlowToTopology(flow: EventFlow): TopologyViewModel {
  const declaredChannels = new Map(
    channelsOf(flow).map((channel) => [channel.name, channel]),
  );
  const publicationsByEvent = new Map<string, EventPublication[]>();
  const subscriptionsByEvent = new Map<string, EventSubscription[]>();
  for (const statement of flow.statements) {
    if (statement.type === "publication") {
      const entries = publicationsByEvent.get(statement.event) ?? [];
      entries.push(statement);
      publicationsByEvent.set(statement.event, entries);
    } else if (statement.type === "subscription") {
      const entries = subscriptionsByEvent.get(statement.event) ?? [];
      entries.push(statement);
      subscriptionsByEvent.set(statement.event, entries);
    }
  }

  const services = servicesOf(flow).map((service) => ({
    name: service.name,
    role: service.role,
    nodeId: serviceNodeId(flow, service.name, service.range),
  }));
  const connections = new Map<string, TopologyConnection>();

  for (const [event, publications] of publicationsByEvent) {
    for (const publication of publications) {
      for (const subscription of subscriptionsByEvent.get(event) ?? []) {
        const key = `${publication.producer}\u0000${subscription.consumer}`;
        let connection = connections.get(key);
        if (!connection) {
          connection = {
            id: `topology:${publication.producer}->${subscription.consumer}`,
            producer: publication.producer,
            consumer: subscription.consumer,
            events: [],
            sourceNodeIds: [],
          };
          connections.set(key, connection);
        }
        let topologyEvent = connection.events.find(
          (entry) => entry.name === event,
        );
        if (!topologyEvent) {
          topologyEvent = {
            name: event,
            description: eventDeclaration(flow, event)?.description,
            metadata: eventDeclaration(flow, event)?.metadata ?? [],
            publicationNodeIds: [],
            subscriptionNodeIds: [],
            channels: [],
          };
          connection.events.push(topologyEvent);
        }
        addUnique(
          topologyEvent.publicationNodeIds,
          nodeIdOf("publication", publication.range),
        );
        addUnique(
          topologyEvent.subscriptionNodeIds,
          nodeIdOf("subscription", subscription.range),
        );
        addUnique(
          connection.sourceNodeIds,
          nodeIdOf("publication", publication.range),
        );
        addUnique(
          connection.sourceNodeIds,
          nodeIdOf("subscription", subscription.range),
        );
        for (const relationship of [
          relationshipFor(publication, declaredChannels),
          relationshipFor(subscription, declaredChannels),
        ]) {
          if (relationship.channel)
            addChannel(topologyEvent.channels, relationship.channel);
        }
      }
    }
  }

  return {
    title: flow.title?.value,
    services,
    connections: [...connections.values()],
  };
}

function eventDeclaration(flow: EventFlow, name: string) {
  const declaration = flow.statements.find(
    (statement) => statement.type === "event" && statement.name === name,
  );
  return declaration?.type === "event" ? declaration : undefined;
}

function serviceNodeId(
  flow: EventFlow,
  name: string,
  fallbackRange: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  },
): AstNodeId {
  const declaration = flow.statements.find(
    (statement) => statement.type === "service" && statement.name === name,
  );
  if (declaration?.type === "service")
    return nodeIdOf("service", declaration.range);
  const relationship = flow.statements.find(
    (statement) =>
      (statement.type === "publication" && statement.producer === name) ||
      (statement.type === "subscription" && statement.consumer === name),
  );
  return relationship
    ? nodeIdOf(relationship.type, relationship.range)
    : nodeIdOf("service", fallbackRange);
}

function relationshipFor(
  relationship: EventPublication | EventSubscription,
  channels: Map<string, ChannelDeclaration>,
): Relationship {
  const channel = relationship.channel;
  return {
    event: relationship.event,
    nodeId: nodeIdOf(relationship.type, relationship.range),
    channel:
      channel === undefined
        ? undefined
        : channelFor(channel, channels, relationship),
  };
}

function channelFor(
  name: string,
  declarations: Map<string, ChannelDeclaration>,
  relationship: EventPublication | EventSubscription,
): TopologyChannel {
  const declaration = declarations.get(name);
  return {
    name,
    kind: declaration?.channelKind ?? "channel",
    broker: declaration?.broker,
    nodeId: declaration
      ? nodeIdOf("channel", declaration.range)
      : nodeIdOf(relationship.type, relationship.range),
  };
}

function addUnique(values: AstNodeId[], value: AstNodeId): void {
  if (!values.includes(value)) values.push(value);
}

function addChannel(values: TopologyChannel[], value: TopologyChannel): void {
  if (!values.some((channel) => channel.name === value.name))
    values.push(value);
}
