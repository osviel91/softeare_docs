/** Source-oriented projection for the human-readable Event Catalog view. */
import {
  channelsOf,
  type ChannelDeclaration,
  type EventFlow,
  type EventMetadataEntry,
  type EventPublication,
  type EventSubscription,
  type EventFlowFailure,
  type EventFlowRetry,
} from "./ast";
import { nodeIdOf, type AstNodeId } from "../diagram/node-id";

export interface CatalogChannel {
  name: string;
  kind: string;
  broker?: string;
  nodeId: AstNodeId;
}

export interface CatalogPublication {
  producer: string;
  nodeId: AstNodeId;
  channel?: CatalogChannel;
}

export interface CatalogSubscription {
  consumer: string;
  nodeId: AstNodeId;
  channel?: CatalogChannel;
}

export interface CatalogEvent {
  name: string;
  nodeId: AstNodeId;
  description?: string;
  metadata: EventMetadataEntry[];
  publications: CatalogPublication[];
  subscriptions: CatalogSubscription[];
}

export interface CatalogViewModel {
  title?: string;
  events: CatalogEvent[];
  failures?: Array<{ id: string; target: string; classification?: string; owner?: string; nodeId: AstNodeId }>;
  retries?: Array<{ id: string; failureId: string; mechanism?: string; target?: string; exhaustion?: string; nodeId: AstNodeId }>;
}

/** Keep catalog ordering declarative; unlike Flow, this never sorts causally. */
export function projectEventFlowToCatalog(flow: EventFlow): CatalogViewModel {
  const declarations = new Map<string, (typeof flow.statements)[number]>();
  const declaredChannels = new Map(
    channelsOf(flow).map((channel) => [channel.name, channel]),
  );
  const declaredOrder: string[] = [];
  const mentionedOrder: string[] = [];
  const seen = new Set<string>();

  for (const statement of flow.statements) {
    if (statement.type === "event" && !declarations.has(statement.name)) {
      declarations.set(statement.name, statement);
      declaredOrder.push(statement.name);
    }
    if (
      (statement.type === "event" ||
        statement.type === "publication" ||
        statement.type === "subscription") &&
      !seen.has(statement.type === "event" ? statement.name : statement.event)
    ) {
      seen.add(statement.type === "event" ? statement.name : statement.event);
      mentionedOrder.push(
        statement.type === "event" ? statement.name : statement.event,
      );
    }
  }

  const publications = new Map<string, EventPublication[]>();
  const subscriptions = new Map<string, EventSubscription[]>();
  for (const publication of flow.statements) {
    if (publication.type !== "publication") continue;
    const entries = publications.get(publication.event) ?? [];
    entries.push(publication);
    publications.set(publication.event, entries);
  }
  for (const subscription of flow.statements) {
    if (subscription.type !== "subscription") continue;
    const entries = subscriptions.get(subscription.event) ?? [];
    entries.push(subscription);
    subscriptions.set(subscription.event, entries);
  }

  const failures = flow.causal?.failures ?? [];
  const retries = flow.causal?.retries ?? [];
  return {
    title: flow.title?.value,
    events: [
      ...declaredOrder,
      ...mentionedOrder.filter((name) => !declarations.has(name)),
    ].map((name) => {
      const declaration = declarations.get(name);
      const firstRelationship =
        publications.get(name)?.[0] ?? subscriptions.get(name)?.[0];
      return {
        name,
        nodeId: declaration
          ? nodeIdOf("event", declaration.range)
          : nodeIdOf(
              firstRelationship?.type ?? "event",
              firstRelationship?.range ?? emptyRange(),
            ),
        description: declaration?.type === "event" ? declaration.description : undefined,
        metadata: declaration?.type === "event" ? declaration.metadata : [],
        publications: (publications.get(name) ?? []).map((entry) =>
          relationshipForPublication(entry, declaredChannels),
        ),
        subscriptions: (subscriptions.get(name) ?? []).map((entry) =>
          relationshipForSubscription(entry, declaredChannels),
        ),
      };
    }),
    ...(failures.length ? { failures: failures.map(catalogFailure) } : {}),
    ...(retries.length ? { retries: retries.map(catalogRetry) } : {}),
  };
}

function catalogFailure(item: EventFlowFailure) {
  return { id: item.id, target: `${item.target.kind} ${item.target.id}`, classification: item.classification, owner: item.owner, nodeId: item.range ? nodeIdOf("failure", item.range) : nodeIdOf("event", emptyRange()) };
}

function catalogRetry(item: EventFlowRetry) {
  return { id: item.id, failureId: item.failureId, mechanism: item.mechanism, target: item.target, exhaustion: item.exhaustion, nodeId: item.range ? nodeIdOf("retry", item.range) : nodeIdOf("event", emptyRange()) };
}

function relationshipForPublication(
  publication: EventPublication,
  channels: Map<string, ChannelDeclaration>,
): CatalogPublication {
  return {
    producer: publication.producer,
    nodeId: nodeIdOf("publication", publication.range),
    channel: channelFor(publication.channel, channels, publication),
  };
}

function relationshipForSubscription(
  subscription: EventSubscription,
  channels: Map<string, ChannelDeclaration>,
): CatalogSubscription {
  return {
    consumer: subscription.consumer,
    nodeId: nodeIdOf("subscription", subscription.range),
    channel: channelFor(subscription.channel, channels, subscription),
  };
}

function channelFor(
  name: string | undefined,
  declarations: Map<string, ChannelDeclaration>,
  relationship: EventPublication | EventSubscription,
): CatalogChannel | undefined {
  if (name === undefined) return undefined;
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

function emptyRange() {
  return { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
}
