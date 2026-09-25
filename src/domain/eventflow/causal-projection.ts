/** Pure graph projection of explicit Event Flow causality. */
import {
  channelsOf,
  eventsOf,
  publicationsOf,
  subscriptionsOf,
  type EventFlow,
  type EventMetadataEntry,
  type EventProvenance,
  type HandlerEffect,
} from "./ast";
import { normalizeEventProvenance } from "./causality";
import { nodeIdOf, type AstNodeId } from "../diagram/node-id";

export type CausalMessageId = `message:${string}`;
export type CausalHandlerId = `handler:${string}`;
export type CausalEffectId = `effect:${string}`;
export type CausalNodeId = CausalMessageId | CausalHandlerId | CausalEffectId;

export type CausalEdgeType =
  | "MESSAGE_HANDLED_BY_HANDLER"
  | "HANDLER_CAUSES_MESSAGE"
  | "HANDLER_HAS_EFFECT";

export interface CausalTopologyContext {
  service: string;
  channel?: string;
  broker?: string;
  channelKind?: string;
  nodeId: AstNodeId;
}

export interface CausalMessage {
  id: CausalMessageId;
  name: string;
  description?: string;
  metadata: EventMetadataEntry[];
  provenance: EventProvenance;
  sourceNodeIds: AstNodeId[];
  topology: {
    publications: CausalTopologyContext[];
    subscriptions: CausalTopologyContext[];
  };
  causalRoot: boolean;
}

export interface CausalHandler {
  id: CausalHandlerId;
  handlerId: string;
  displayName: string;
  service?: string;
  description?: string;
  metadata: EventMetadataEntry[];
  sourceNodeIds: AstNodeId[];
}

export interface CausalEffect {
  id: CausalEffectId;
  effectId: string;
  kind?: string;
  description: string;
  metadata: EventMetadataEntry[];
  handlerId: CausalHandlerId;
  sourceNodeIds: AstNodeId[];
}

export interface CausalEdge {
  id: string;
  type: CausalEdgeType;
  from: CausalNodeId;
  to: CausalNodeId;
  sourceNodeIds: AstNodeId[];
}

export interface CausalComponent {
  id: string;
  nodeIds: CausalNodeId[];
  rootNodeIds: CausalNodeId[];
}

export interface CausalViewModel {
  title?: string;
  messages: CausalMessage[];
  handlers: CausalHandler[];
  effects: CausalEffect[];
  edges: CausalEdge[];
  components: CausalComponent[];
}

export function messageId(name: string): CausalMessageId {
  return `message:${name}`;
}

export function handlerNodeId(id: string): CausalHandlerId {
  return `handler:${id}`;
}

export function effectId(id: string): CausalEffectId {
  return `effect:${id}`;
}

/**
 * Project only authored causal facts. Publications and subscriptions are kept
 * as message context and never participate in causal edge construction.
 */
export function projectEventFlowToCausalView(flow: EventFlow): CausalViewModel {
  const causal = flow.causal;
  if (!causal) return emptyView(flow.title?.value);

  const eventDeclarations = new Map(eventsOf(flow).map((event) => [event.name, event]));
  const messages = new Map<string, CausalMessage>();
  const handlers = new Map<string, CausalHandler>();
  const effects = new Map<string, CausalEffect>();
  const edges: CausalEdge[] = [];
  const edgeKeys = new Set<string>();

  const ensureMessage = (name: string): CausalMessage => {
    const existing = messages.get(name);
    if (existing) return existing;
    const declaration = eventDeclarations.get(name);
    const message: CausalMessage = {
      id: messageId(name),
      name,
      description: declaration?.description,
      metadata: declaration?.metadata ?? [],
      provenance: normalizeEventProvenance(declaration?.provenance),
      sourceNodeIds: declaration ? [nodeIdOf("event", declaration.range)] : [],
      topology: topologyFor(flow, name),
      causalRoot: false,
    };
    messages.set(name, message);
    return message;
  };

  // A declared event can be useful isolated or partially documented; causal
  // projection must not discard it merely because no relationship is known.
  for (const event of eventsOf(flow)) ensureMessage(event.name);

  for (const handler of causal.handlers) {
    if (!handlers.has(handler.id)) {
      handlers.set(handler.id, {
        id: handlerNodeId(handler.id),
        handlerId: handler.id,
        displayName: handler.id,
        service: handler.service,
        description: handler.description,
        metadata: handler.metadata,
        sourceNodeIds: handler.range
          ? [nodeIdOf("handler", handler.range)]
          : [],
      });
    }
  }

  for (const input of causal.inputs) {
    const message = ensureMessage(input.event);
    addSource(message.sourceNodeIds, input.range, "handler-input");
    addEdge(
      edges,
      edgeKeys,
      "MESSAGE_HANDLED_BY_HANDLER",
      message.id,
      handlerNodeId(input.handlerId),
      input.range,
      "handler-input",
    );
  }

  for (const output of causal.outputs) {
    const message = ensureMessage(output.event);
    addSource(message.sourceNodeIds, output.range, "handler-output");
    addEdge(
      edges,
      edgeKeys,
      "HANDLER_CAUSES_MESSAGE",
      handlerNodeId(output.handlerId),
      message.id,
      output.range,
      "handler-output",
    );
  }

  for (const effect of causal.effects) {
    const projected = projectEffect(effect);
    if (!effects.has(effect.id)) effects.set(effect.id, projected);
    addEdge(
      edges,
      edgeKeys,
      "HANDLER_HAS_EFFECT",
      handlerNodeId(effect.handlerId),
      projected.id,
      effect.range,
      "effect",
    );
  }

  const allMessages = [...messages.values()];
  const allHandlers = [...handlers.values()];
  const allEffects = [...effects.values()];
  const nodes = [
    ...allMessages.map((entry) => entry.id),
    ...allHandlers.map((entry) => entry.id),
    ...allEffects.map((entry) => entry.id),
  ];
  const incoming = new Set(edges.map((edge) => edge.to));
  for (const message of allMessages) message.causalRoot = !incoming.has(message.id);

  return {
    title: flow.title?.value,
    messages: allMessages,
    handlers: allHandlers,
    effects: allEffects,
    edges,
    components: components(nodes, edges),
  };
}

export function downstreamCausalNeighbors(
  view: CausalViewModel,
  nodeId: CausalNodeId,
): CausalNodeId[] {
  return view.edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to);
}

export function upstreamCausalNeighbors(
  view: CausalViewModel,
  nodeId: CausalNodeId,
): CausalNodeId[] {
  return view.edges.filter((edge) => edge.to === nodeId).map((edge) => edge.from);
}

export function handlersForMessage(
  view: CausalViewModel,
  id: CausalMessageId,
): CausalHandler[] {
  const ids = new Set(
    view.edges
      .filter((edge) => edge.type === "MESSAGE_HANDLED_BY_HANDLER" && edge.from === id)
      .map((edge) => edge.to),
  );
  return view.handlers.filter((handler) => ids.has(handler.id));
}

export function inputsForHandler(
  view: CausalViewModel,
  id: CausalHandlerId,
): CausalMessage[] {
  const ids = new Set(
    view.edges
      .filter((edge) => edge.type === "MESSAGE_HANDLED_BY_HANDLER" && edge.to === id)
      .map((edge) => edge.from),
  );
  return view.messages.filter((message) => ids.has(message.id));
}

export function outputsForHandler(
  view: CausalViewModel,
  id: CausalHandlerId,
): CausalMessage[] {
  const ids = new Set(
    view.edges
      .filter((edge) => edge.type === "HANDLER_CAUSES_MESSAGE" && edge.from === id)
      .map((edge) => edge.to),
  );
  return view.messages.filter((message) => ids.has(message.id));
}

export function effectsForHandler(
  view: CausalViewModel,
  id: CausalHandlerId,
): CausalEffect[] {
  const ids = new Set(
    view.edges
      .filter((edge) => edge.type === "HANDLER_HAS_EFFECT" && edge.from === id)
      .map((edge) => edge.to),
  );
  return view.effects.filter((effect) => ids.has(effect.id));
}

function projectEffect(effect: HandlerEffect): CausalEffect {
  return {
    id: effectId(effect.id),
    effectId: effect.id,
    kind: effect.kind,
    description: effect.description,
    metadata: effect.metadata,
    handlerId: handlerNodeId(effect.handlerId),
    sourceNodeIds: effect.range ? [nodeIdOf("effect", effect.range)] : [],
  };
}

function topologyFor(flow: EventFlow, event: string): CausalMessage["topology"] {
  const channels = new Map(channelsOf(flow).map((channel) => [channel.name, channel]));
  const context = (relationship: { service: string; channel?: string; nodeId: AstNodeId }) => {
    const channel = relationship.channel ? channels.get(relationship.channel) : undefined;
    return {
      service: relationship.service,
      ...(relationship.channel ? { channel: relationship.channel } : {}),
      ...(channel?.broker ? { broker: channel.broker } : {}),
      ...(channel ? { channelKind: channel.channelKind } : {}),
      nodeId: relationship.nodeId,
    };
  };
  return {
    publications: publicationsOf(flow)
      .filter((entry) => entry.event === event)
      .map((entry) => context({
        service: entry.producer,
        channel: entry.channel,
        nodeId: nodeIdOf("publication", entry.range),
      })),
    subscriptions: subscriptionsOf(flow)
      .filter((entry) => entry.event === event)
      .map((entry) => context({
        service: entry.consumer,
        channel: entry.channel,
        nodeId: nodeIdOf("subscription", entry.range),
      })),
  };
}

function addEdge(
  edges: CausalEdge[],
  keys: Set<string>,
  type: CausalEdgeType,
  from: CausalNodeId,
  to: CausalNodeId,
  range: { start: { line: number; column: number }; end: { line: number; column: number } } | undefined,
  kind: "handler-input" | "handler-output" | "effect",
): void {
  const key = `${type}\u0000${from}\u0000${to}`;
  if (keys.has(key)) return;
  keys.add(key);
  edges.push({
    id: `causal:${type}:${from}->${to}`,
    type,
    from,
    to,
    sourceNodeIds: range ? [nodeIdOf(kind, range)] : [],
  });
}

function addSource(
  ids: AstNodeId[],
  range: { start: { line: number; column: number }; end: { line: number; column: number } } | undefined,
  kind: "handler-input" | "handler-output",
): void {
  if (range) addUnique(ids, nodeIdOf(kind, range));
}

function components(nodes: CausalNodeId[], edges: CausalEdge[]): CausalComponent[] {
  const adjacency = new Map<CausalNodeId, CausalNodeId[]>(nodes.map((id) => [id, []]));
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }
  const visited = new Set<CausalNodeId>();
  const result: CausalComponent[] = [];
  for (const start of nodes) {
    if (visited.has(start)) continue;
    const nodeIds: CausalNodeId[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const current = queue.shift()!;
      nodeIds.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    const members = new Set(nodeIds);
    result.push({
      id: `component:${nodeIds[0]}`,
      nodeIds,
      rootNodeIds: nodeIds.filter(
        (id) => !edges.some((edge) => edge.to === id && members.has(edge.from)),
      ),
    });
  }
  return result;
}

function addUnique(values: AstNodeId[], value: AstNodeId): void {
  if (!values.includes(value)) values.push(value);
}

function emptyView(title?: string): CausalViewModel {
  return {
    ...(title === undefined ? {} : { title }),
    messages: [],
    handlers: [],
    effects: [],
    edges: [],
    components: [],
  };
}
