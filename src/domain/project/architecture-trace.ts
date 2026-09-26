import type { SourceRange } from "../diagram/ast";
import type { SemanticMessageOccurrence } from "../diagram/semantic-messages";
import { nodeIdOf } from "../diagram/node-id";
import type { CausalEdge, CausalNodeId } from "../eventflow/causal-projection";
import type {
  EventFlowCausalIndex,
  ProjectIndex,
} from "./project-index";
import type { ResourceId } from "../workspace/resource-id";
import type { SemanticMessageIdentity } from "../workspace/metadata";

export type TraceDirection = "upstream" | "downstream" | "both";
export type TraceConfidence = "authoritative" | "candidate" | "unknown";

export type UnknownBoundaryReason =
  | "no-causal-representation"
  | "no-documented-output"
  | "unbound-output"
  | "unresolved-reference"
  | "recovery-continuation-unknown"
  | "depth-limit"
  | "node-limit";

export interface TraceSource {
  resourceId: ResourceId;
  resourcePath?: string;
  nodeId?: string;
  range?: SourceRange;
}

export interface TraceResolutionCandidate {
  name: string;
  kind: "event" | "command";
  source: TraceSource;
  representation: "sequence-occurrence" | "event-flow-message";
}

interface TraceNodeBase {
  id: string;
  confidence: TraceConfidence;
  label: string;
  source?: TraceSource;
}

export type TraceNode =
  | (TraceNodeBase & { kind: "identity"; identity: SemanticMessageIdentity })
  | (TraceNodeBase & {
      kind: "execution-occurrence";
      occurrence: SemanticMessageOccurrence;
      representation: "sequence";
    })
  | (TraceNodeBase & {
      kind: "causal-message";
      name: string;
      messageKind: "event" | "command";
      resourceId: ResourceId;
      messageRef?: string;
    })
  | (TraceNodeBase & { kind: "handler"; handlerId: string; resourceId: ResourceId })
  | (TraceNodeBase & { kind: "effect"; effectId: string; resourceId: ResourceId })
  | (TraceNodeBase & { kind: "failure"; failureId: string; resourceId: ResourceId })
  | (TraceNodeBase & { kind: "retry"; retryId: string; resourceId: ResourceId })
  | (TraceNodeBase & {
      kind: "unknown-boundary";
      reason: UnknownBoundaryReason;
      resolutionCandidates: TraceResolutionCandidate[];
    });

export type TraceEdgeKind =
  | "occurrence-binds-identity"
  | "identity-represented-by-causal-message"
  | "causal-message-handled-by"
  | "handler-causes-causal-message"
  | "handler-owns-effect"
  | "entity-fails"
  | "failure-retried"
  | "retry-initiates-causal-message"
  | "retry-targets-handler"
  | "unknown-continuation";

export interface TraceEdge {
  id: string;
  kind: TraceEdgeKind;
  from: string;
  to: string;
  confidence: TraceConfidence;
  /** Binding edges are navigable in both directions; causal edges are directed. */
  traversal: "forward" | "both";
  basis: "messageRef" | "causal-declaration" | "causal-relation" | "unknown-boundary";
  source?: TraceSource;
  /** True only when this edge closes a path-local graph cycle. */
  cycleReference?: boolean;
}

export interface ArchitectureTrace {
  projectId: string;
  selected: string;
  direction: TraceDirection;
  nodes: TraceNode[];
  edges: TraceEdge[];
  terminals: string[];
  truncated: boolean;
  limits: { maxDepth: number; maxNodes: number };
}

export interface TraceArchitectureOptions {
  messageId: string;
  direction?: TraceDirection;
  maxDepth?: number;
  maxNodes?: number;
  includeCandidates?: boolean;
  includeRecovery?: boolean;
}

export type TraceQueryStart =
  | { messageId: string }
  | { resourceId: ResourceId; name: string; step?: number };

export interface TraceQueryResolution {
  status: "authoritative" | "candidate" | "unknown";
  messageId?: string;
  source?: TraceSource;
  candidates: TraceResolutionCandidate[];
  reason?: "unbound-start" | "unresolved-reference";
}

export interface ArchitectureTraceQuery {
  resolution: TraceQueryResolution;
  trace: ArchitectureTrace | null;
}

interface FactNode {
  id: string;
  node: TraceNode;
}

interface FactEdge {
  edge: TraceEdge;
  from: string;
  to: string;
}

interface FactGraph {
  nodes: Map<string, FactNode>;
  edges: FactEdge[];
  candidates: Map<string, TraceResolutionCandidate[]>;
  outputStatus: Map<string, UnknownBoundaryReason>;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_NODES = 500;

/**
 * Traverse authoritative project facts. Candidate nodes are deliberately leaves:
 * name evidence can suggest a repair, but it can never manufacture descendants.
 */
export function traceArchitecture(
  index: ProjectIndex,
  options: TraceArchitectureOptions,
): ArchitectureTrace {
  const direction = options.direction ?? "downstream";
  const maxDepth = limit(options.maxDepth, DEFAULT_MAX_DEPTH, 0, 32);
  const maxNodes = limit(options.maxNodes, DEFAULT_MAX_NODES, 1, 5000);
  const graph = buildFactGraph(index, options.includeCandidates ?? false, options.includeRecovery ?? false);
  const selected = identityId(options.messageId);
  const identity = (index.semanticMessages ?? []).find((message) => message.id === options.messageId);
  if (!identity) {
    return {
      projectId: index.projectId,
      selected,
      direction,
      nodes: [],
      edges: [],
      terminals: [],
      truncated: false,
      limits: { maxDepth, maxNodes },
    };
  }

  graph.nodes.set(selected, {
    id: selected,
    node: {
      id: selected,
      kind: "identity",
      confidence: "authoritative",
      label: identity.name,
      identity,
    },
  });

  const nodes = new Map<string, TraceNode>([[selected, graph.nodes.get(selected)!.node]]);
  const edges = new Map<string, TraceEdge>();
  const terminals = new Set<string>();
  let truncated = false;

  const walk = (walkDirection: "upstream" | "downstream"): void => {
    const queue: Array<{ id: string; depth: number; path: Set<string> }> = [
      { id: selected, depth: 0, path: new Set([selected]) },
    ];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      const neighbors = neighborsOf(graph.edges, current.id, walkDirection);
      if (
        current.id === selected &&
        walkDirection === "downstream" &&
        !graph.edges.some(
          ({ edge }) => edge.from === selected && edge.kind === "identity-represented-by-causal-message" && edge.confidence === "authoritative",
        )
      ) {
        addBoundary("no-causal-representation", current.id, current, graph, nodes, edges, terminals, maxNodes);
      }
      if (current.depth >= maxDepth) {
        truncated = true;
        addBoundary("depth-limit", current.id, current, graph, nodes, edges, terminals, maxNodes);
        continue;
      }
      if (neighbors.length === 0) {
        addTerminalFor(current.id, walkDirection, graph, nodes, edges, terminals, maxNodes);
        continue;
      }
      for (const neighbor of neighbors) {
        const edge = neighbor.edge;
        const cycleReference = current.path.has(neighbor.id);
        const nextEdge = cycleReference ? { ...edge, cycleReference: true } : edge;
        edges.set(edge.id, mergeEdge(edges.get(edge.id), nextEdge));
        if (cycleReference) continue;
        if (!nodes.has(neighbor.id)) {
          if (nodes.size + 1 >= maxNodes) {
            truncated = true;
            addBoundary("node-limit", current.id, current, graph, nodes, edges, terminals, maxNodes);
            continue;
          }
          const fact = graph.nodes.get(neighbor.id);
          if (!fact) continue;
          nodes.set(neighbor.id, fact.node);
        }
        const nextPath = new Set(current.path);
        nextPath.add(neighbor.id);
        queue.push({ id: neighbor.id, depth: current.depth + 1, path: nextPath });
      }
    }
  };

  if (direction === "upstream" || direction === "both") walk("upstream");
  if (direction === "downstream" || direction === "both") walk("downstream");

  if (direction === "downstream" && neighborsOf(graph.edges, selected, "downstream").length === 0) {
    addTerminalFor(selected, "downstream", graph, nodes, edges, terminals, maxNodes);
  }
  return {
    projectId: index.projectId,
    selected,
    direction,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    terminals: [...terminals],
    truncated,
    limits: { maxDepth, maxNodes },
  };
}

/** Resolve a stable identity or exact indexed occurrence before traversing. */
export function traceArchitectureQuery(
  index: ProjectIndex,
  start: TraceQueryStart,
  options: Omit<TraceArchitectureOptions, "messageId"> = {},
): ArchitectureTraceQuery {
  if ("messageId" in start) {
    const identity = (index.semanticMessages ?? []).find((message) => message.id === start.messageId);
    return identity
      ? {
          resolution: { status: "authoritative", messageId: identity.id, candidates: [] },
          trace: traceArchitecture(index, { ...options, messageId: identity.id }),
        }
      : { resolution: { status: "unknown", candidates: [], reason: "unresolved-reference" }, trace: null };
  }

  const sequenceMatches = (index.semanticOccurrences ?? []).filter(
    (entry) => entry.resourceId === start.resourceId && entry.name === start.name && (start.step === undefined || entry.step === start.step),
  );
  const sequence = sequenceMatches.length === 1 ? sequenceMatches[0] : undefined;
  const eventMatches = (index.eventFlowMessages ?? []).filter(
    (entry) => entry.resourceId === start.resourceId && entry.name === start.name,
  );
  const event = eventMatches.length === 1 ? eventMatches[0] : undefined;
  const occurrence = sequence ?? event;
  if (!occurrence) {
    return { resolution: { status: "unknown", candidates: [], reason: "unresolved-reference" }, trace: null };
  }

  const kind = occurrence.kind;
  const messageRef = "messageRef" in occurrence ? occurrence.messageRef : undefined;
  const identity = (index.semanticMessages ?? []).find((message) => message.id === messageRef && message.kind === kind);
  const source = "range" in occurrence
    ? sourceOf(occurrence.resourceId, new Map(index.resources.map((resource) => [resource.id, { path: resource.path }])), nodeIdOf("message", occurrence.range), occurrence.range)
    : sourceOf(occurrence.resourceId, new Map(index.resources.map((resource) => [resource.id, { path: resource.path }])), occurrence.nodeId, occurrence.sourceRange);
  const candidates = compatibleCandidatesByName(index, occurrence.name, kind);
  return identity
    ? {
        resolution: { status: "authoritative", messageId: identity.id, source, candidates },
        trace: traceArchitecture(index, { ...options, messageId: identity.id }),
      }
    : { resolution: { status: "candidate", source, candidates, reason: "unbound-start" }, trace: null };
}

function buildFactGraph(index: ProjectIndex, includeCandidates: boolean, includeRecovery: boolean): FactGraph {
  const nodes = new Map<string, FactNode>();
  const edges: FactEdge[] = [];
  const candidates = new Map<string, TraceResolutionCandidate[]>();
  const outputStatus = new Map<string, UnknownBoundaryReason>();
  const identities = new Map((index.semanticMessages ?? []).map((message) => [message.id, message]));
  const validRef = (ref: string | undefined, kind: "event" | "command") => {
    const identity = ref ? identities.get(ref) : undefined;
    return identity?.kind === kind ? identity : undefined;
  };
  const resources = new Map(index.resources.map((resource) => [resource.id, resource]));
  const add = (node: TraceNode): void => { nodes.set(node.id, { id: node.id, node }); };
  const addEdge = (edge: TraceEdge): void => { edges.push({ edge, from: edge.from, to: edge.to }); };

  for (const occurrence of index.semanticOccurrences ?? []) {
    if (!occurrence.messageRef || !validRef(occurrence.messageRef, occurrence.kind)) continue;
    const id = occurrenceId(occurrence.resourceId, occurrence);
    add({
      id,
      kind: "execution-occurrence",
      confidence: "authoritative",
      label: `${occurrence.name} (${occurrence.operation})`,
      source: sourceOf(occurrence.resourceId, resources, nodeIdOf("message", occurrence.range), occurrence.range),
      occurrence,
      representation: "sequence",
    });
    addEdge({
      id: `trace:bind:${id}:${identityId(occurrence.messageRef)}`,
      kind: "occurrence-binds-identity",
      from: id,
      to: identityId(occurrence.messageRef),
      confidence: "authoritative",
      traversal: "both",
      basis: "messageRef",
      source: sourceOf(occurrence.resourceId, resources, nodeIdOf("message", occurrence.range), occurrence.range),
    });
  }

  for (const causal of index.eventFlowCausality ?? []) {
    const eventEntities = new Map((index.eventFlowMessages ?? [])
      .filter((entry) => entry.resourceId === causal.resourceId)
      .map((entry) => [entry.name, entry]));
    const authoritativeMessages = new Set<string>();
    for (const message of causal.view.messages) {
      const identity = validRef(message.messageRef, message.kind);
      const localId = causalMessageId(causal.resourceId, message.id);
      const entity = eventEntities.get(message.name);
      const source = sourceOf(
        causal.resourceId,
        resources,
        message.sourceNodeIds[0],
        entity?.sourceRange,
      );
      if (identity) {
        authoritativeMessages.add(message.id);
        add({
          id: localId,
          kind: "causal-message",
          confidence: "authoritative",
          label: message.name,
          source,
          name: message.name,
          messageKind: message.kind,
          resourceId: causal.resourceId,
          messageRef: message.messageRef,
        });
        addEdge({
          id: `trace:represent:${identityId(identity.id)}:${localId}`,
          kind: "identity-represented-by-causal-message",
          from: identityId(identity.id),
          to: localId,
          confidence: "authoritative",
          traversal: "both",
          basis: "messageRef",
          source,
        });
      } else if (includeCandidates && (message.messageRef === undefined || !identities.has(message.messageRef ?? ""))) {
        add({
          id: localId,
          kind: "causal-message",
          confidence: "candidate",
          label: message.name,
          source,
          name: message.name,
          messageKind: message.kind,
          resourceId: causal.resourceId,
          messageRef: message.messageRef,
        });
      }
    }

    const localNode = (id: CausalNodeId): string =>
      id.startsWith("message:")
        ? causalMessageId(causal.resourceId, id)
        : `${causal.resourceId}:${id}`;
    for (const edge of causal.view.edges) {
      const fromMessage = causal.view.messages.find((message) => message.id === edge.from);
      const toMessage = causal.view.messages.find((message) => message.id === edge.to);
      if (edge.type === "MESSAGE_HANDLED_BY_HANDLER") {
        if (!fromMessage || !authoritativeMessages.has(fromMessage.id)) continue;
        const handler = causal.view.handlers.find((entry) => entry.id === edge.to);
        if (!handler) continue;
        const handlerId = localNode(handler.id);
        add({ id: handlerId, kind: "handler", confidence: "authoritative", label: handler.displayName, source: sourceOf(causal.resourceId, resources, handler.sourceNodeIds[0]), handlerId: handler.handlerId, resourceId: causal.resourceId });
        addEdge(causalEdge("causal-message-handled-by", localNode(edge.from), handlerId, edge, causal, resources));
      } else if (edge.type === "HANDLER_CAUSES_MESSAGE") {
        const handler = causal.view.handlers.find((entry) => entry.id === edge.from);
        if (!handler || !toMessage) continue;
        const handlerId = localNode(handler.id);
        add({ id: handlerId, kind: "handler", confidence: "authoritative", label: handler.displayName, source: sourceOf(causal.resourceId, resources, handler.sourceNodeIds[0]), handlerId: handler.handlerId, resourceId: causal.resourceId });
        const targetId = localNode(toMessage.id);
        const identity = validRef(toMessage.messageRef, toMessage.kind);
        if (identity && authoritativeMessages.has(toMessage.id)) {
          addEdge(causalEdge("handler-causes-causal-message", handlerId, targetId, edge, causal, resources));
          continue;
        }
        outputStatus.set(
          handlerId,
          toMessage.sourceNodeIds.some((sourceNodeId) => sourceNodeId.startsWith("event@"))
            ? "unbound-output"
            : "unresolved-reference",
        );
        candidates.set(handlerId, compatibleCandidates(index, { id: "", name: toMessage.name, kind: toMessage.kind }, resources));
        if (includeCandidates && !nodes.has(targetId)) {
          add({ id: targetId, kind: "causal-message", confidence: "candidate", label: toMessage.name, source: sourceOf(causal.resourceId, resources, toMessage.sourceNodeIds[0]), name: toMessage.name, messageKind: toMessage.kind, resourceId: causal.resourceId, messageRef: toMessage.messageRef });
          addEdge({ ...causalEdge("handler-causes-causal-message", handlerId, targetId, edge, causal, resources), confidence: "candidate", basis: "causal-relation" });
        }
      } else if (edge.type === "HANDLER_HAS_EFFECT") {
        const handler = causal.view.handlers.find((entry) => entry.id === edge.from);
        const effect = causal.view.effects.find((entry) => entry.id === edge.to);
        if (!handler || !effect) continue;
        const handlerId = localNode(handler.id);
        const effectId = localNode(effect.id);
        add({ id: handlerId, kind: "handler", confidence: "authoritative", label: handler.displayName, source: sourceOf(causal.resourceId, resources, handler.sourceNodeIds[0]), handlerId: handler.handlerId, resourceId: causal.resourceId });
        add({ id: effectId, kind: "effect", confidence: "authoritative", label: effect.description, source: sourceOf(causal.resourceId, resources, effect.sourceNodeIds[0]), effectId: effect.effectId, resourceId: causal.resourceId });
        addEdge(causalEdge("handler-owns-effect", handlerId, effectId, edge, causal, resources));
      } else if (includeRecovery) {
        addRecoveryEdge(edge, causal, resources, identities, nodes, edges, localNode, authoritativeMessages);
      }
    }

  }

  for (const identity of index.semanticMessages ?? []) {
    candidates.set(identity.id, compatibleCandidates(index, identity, resources));
    if (!includeCandidates) continue;
    for (const candidate of candidates.get(identity.id) ?? []) {
      const candidateId = `candidate:${candidate.representation}:${candidate.source.resourceId}:${candidate.source.nodeId ?? "unknown"}`;
      if (candidate.representation === "sequence-occurrence") {
        const occurrence = (index.semanticOccurrences ?? []).find(
          (entry) => entry.resourceId === candidate.source.resourceId && nodeIdOf("message", entry.range) === candidate.source.nodeId,
        );
        if (!occurrence) continue;
        add({ id: candidateId, kind: "execution-occurrence", confidence: "candidate", label: `${candidate.name} (${occurrence.operation})`, source: candidate.source, occurrence, representation: "sequence" });
        addEdge({ id: `trace:candidate:${identityId(identity.id)}:${candidateId}`, kind: "occurrence-binds-identity", from: identityId(identity.id), to: candidateId, confidence: "candidate", traversal: "forward", basis: "causal-declaration", source: candidate.source });
      } else {
        const entity = (index.eventFlowMessages ?? []).find(
          (entry) => entry.resourceId === candidate.source.resourceId && entry.nodeId === candidate.source.nodeId,
        );
        if (!entity) continue;
        add({ id: candidateId, kind: "causal-message", confidence: "candidate", label: entity.name, source: candidate.source, name: entity.name, messageKind: entity.kind, resourceId: entity.resourceId, messageRef: entity.messageRef });
        addEdge({ id: `trace:candidate:${identityId(identity.id)}:${candidateId}`, kind: "identity-represented-by-causal-message", from: identityId(identity.id), to: candidateId, confidence: "candidate", traversal: "both", basis: "causal-declaration", source: candidate.source });
      }
    }
  }
  return { nodes, edges, candidates, outputStatus };
}

function addRecoveryEdge(
  edge: CausalEdge,
  causal: EventFlowCausalIndex,
  resources: Map<string, { path: string }>,
  identities: Map<string, SemanticMessageIdentity>,
  nodes: Map<string, FactNode>,
  edges: FactEdge[],
  localNode: (id: CausalNodeId) => string,
  authoritativeMessages: Set<string>,
): void {
  const source = sourceOf(causal.resourceId, resources, edge.sourceNodeIds[0]);
  if (edge.type === "ENTITY_FAILED") {
    const failure = causal.view.failures?.find((entry) => entry.id === edge.to);
    if (!failure) return;
    const target = localNode(edge.from);
    if (!nodes.has(target)) return;
    const id = localNode(failure.id);
    nodes.set(id, { id, node: { id, kind: "failure", confidence: "authoritative", label: failure.failureId, source, failureId: failure.failureId, resourceId: causal.resourceId } });
    edges.push({ from: target, to: id, edge: { id: `trace:${id}`, kind: "entity-fails", from: target, to: id, confidence: "authoritative", traversal: "forward", basis: "causal-relation", source } });
  } else if (edge.type === "FAILURE_RETRIED") {
    const retry = causal.view.retries?.find((entry) => entry.id === edge.to);
    if (!retry) return;
    const failureId = localNode(edge.from);
    if (!nodes.has(failureId)) return;
    const id = localNode(retry.id);
    nodes.set(id, { id, node: { id, kind: "retry", confidence: "authoritative", label: retry.retryId, source, retryId: retry.retryId, resourceId: causal.resourceId } });
    edges.push({ from: failureId, to: id, edge: { id: `trace:${id}`, kind: "failure-retried", from: failureId, to: id, confidence: "authoritative", traversal: "forward", basis: "causal-relation", source } });
  } else if (edge.type === "RETRY_INITIATES_MESSAGE") {
    const retryId = localNode(edge.from);
    if (!nodes.has(retryId)) return;
    const message = causal.view.messages.find((entry) => entry.id === edge.to);
    if (!message) return;
    const id = localNode(message.id);
    const identity = message.messageRef ? identities.get(message.messageRef) : undefined;
    if (!identity || !authoritativeMessages.has(message.id)) return;
    edges.push({ from: retryId, to: id, edge: { id: `trace:retry:${retryId}:${id}`, kind: "retry-initiates-causal-message", from: retryId, to: id, confidence: "authoritative", traversal: "forward", basis: "messageRef", source } });
  } else if (edge.type === "RETRY_TARGETS_HANDLER") {
    const retryId = localNode(edge.from);
    const handlerId = localNode(edge.to);
    if (!nodes.has(retryId) || !nodes.has(handlerId)) return;
    edges.push({ from: retryId, to: handlerId, edge: { id: `trace:retry:${retryId}:${handlerId}`, kind: "retry-targets-handler", from: retryId, to: handlerId, confidence: "authoritative", traversal: "forward", basis: "causal-relation", source } });
  }
}

function addTerminalFor(
  id: string,
  direction: "upstream" | "downstream",
  graph: FactGraph,
  nodes: Map<string, TraceNode>,
  edges: Map<string, TraceEdge>,
  terminals: Set<string>,
  maxNodes: number,
): void {
  const node = graph.nodes.get(id)?.node;
  if (!node || node.kind === "unknown-boundary" || node.kind === "effect") return;
  let reason: UnknownBoundaryReason = "no-documented-output";
  if (node.kind === "identity") reason = "no-causal-representation";
  else if (node.kind === "causal-message" && direction === "downstream") reason = "no-documented-output";
  else if (node.kind === "handler") reason = graph.outputStatus.get(id) ?? "no-documented-output";
  else if (node.kind === "retry") reason = "recovery-continuation-unknown";
  addBoundary(reason, id, { id, depth: 0, path: new Set() }, graph, nodes, edges, terminals, maxNodes);
}

function addBoundary(
  reason: UnknownBoundaryReason,
  from: string,
  _current: { id: string; depth: number; path: Set<string> },
  graph: FactGraph,
  nodes: Map<string, TraceNode>,
  edges: Map<string, TraceEdge>,
  terminals: Set<string>,
  maxNodes: number,
): void {
  if (nodes.size >= maxNodes) return;
  const id = `boundary:${from}:${reason}`;
  if (!nodes.has(id)) {
    nodes.set(id, {
      id,
      kind: "unknown-boundary",
      confidence: "unknown",
      label: reason,
      reason,
      resolutionCandidates: graph.candidates.get(from) ?? graph.candidates.get(identityFromNode(from)) ?? [],
    });
  }
  edges.set(`trace:unknown:${from}:${reason}`, {
    id: `trace:unknown:${from}:${reason}`,
    kind: "unknown-continuation",
    from,
    to: id,
    confidence: "unknown",
    traversal: "forward",
    basis: "unknown-boundary",
  });
  terminals.add(id);
}

function neighborsOf(edges: FactEdge[], id: string, direction: "upstream" | "downstream"): Array<{ edge: TraceEdge; id: string }> {
  return edges
    .filter(({ edge }) => direction === "downstream"
      ? edge.from === id || (edge.traversal === "both" && edge.to === id)
      : edge.to === id || (edge.traversal === "both" && edge.from === id))
    .map((entry) => ({ ...entry, id: entry.edge.from === id ? entry.to : entry.from }))
    .sort((left, right) => left.edge.id.localeCompare(right.edge.id));
}

function causalEdge(
  kind: TraceEdgeKind,
  from: string,
  to: string,
  sourceEdge: CausalEdge,
  causal: EventFlowCausalIndex,
  resources: Map<string, { path: string }>,
): TraceEdge {
  return {
    id: `trace:${kind}:${from}:${to}`,
    kind,
    from,
    to,
    confidence: "authoritative",
    traversal: "forward",
    basis: "causal-relation",
    source: sourceOf(causal.resourceId, resources, sourceEdge.sourceNodeIds[0]),
  };
}

function compatibleCandidates(
  index: ProjectIndex,
  identity: SemanticMessageIdentity,
  resources: Map<string, { path: string }>,
): TraceResolutionCandidate[] {
  const result: TraceResolutionCandidate[] = [];
  for (const occurrence of index.semanticOccurrences ?? []) {
    if (occurrence.name !== identity.name || occurrence.kind !== identity.kind) continue;
    if (occurrence.messageRef) continue;
    result.push({ name: occurrence.name, kind: occurrence.kind, representation: "sequence-occurrence", source: sourceOf(occurrence.resourceId, resources, `message@${occurrence.range.start.line}:${occurrence.range.start.column}`, occurrence.range) });
  }
  for (const entity of index.eventFlowMessages ?? []) {
    if (entity.name !== identity.name || entity.kind !== identity.kind || entity.messageRef) continue;
    result.push({ name: entity.name, kind: entity.kind, representation: "event-flow-message", source: sourceOf(entity.resourceId, resources, entity.nodeId, entity.sourceRange) });
  }
  return result.sort((a, b) => `${a.source.resourceId}:${a.source.nodeId}`.localeCompare(`${b.source.resourceId}:${b.source.nodeId}`));
}

function compatibleCandidatesByName(
  index: ProjectIndex,
  name: string,
  kind: "event" | "command",
): TraceResolutionCandidate[] {
  const resources = new Map(index.resources.map((resource) => [resource.id, { path: resource.path }]));
  return compatibleCandidates(index, { id: "", name, kind }, resources);
}

function sourceOf(
  resourceId: string,
  resources: Map<string, { path: string }>,
  nodeId?: string,
  range?: SourceRange,
): TraceSource {
  return { resourceId, resourcePath: resources.get(resourceId)?.path, ...(nodeId ? { nodeId } : {}), ...(range ? { range } : {}) };
}

function mergeEdge(existing: TraceEdge | undefined, next: TraceEdge): TraceEdge {
  return existing?.cycleReference ? existing : next.cycleReference ? { ...next, cycleReference: true } : next;
}

function identityId(id: string): string { return `identity:${id}`; }
function identityFromNode(id: string): string { return id.startsWith("identity:") ? id.slice("identity:".length) : ""; }
function causalMessageId(resourceId: string, id: CausalNodeId): string { return `causal-message:${resourceId}:${id}`; }
function occurrenceId(resourceId: string, occurrence: SemanticMessageOccurrence & { resourceId?: string }): string { return `occurrence:${resourceId}:${occurrence.step}:${occurrence.range.start.line}:${occurrence.range.start.column}`; }
function limit(value: number | undefined, fallback: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? Math.floor(value!) : fallback)); }
