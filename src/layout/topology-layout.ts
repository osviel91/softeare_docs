import type {
  TopologyConnection,
  TopologyViewModel,
} from "../domain/eventflow/topology-projection";
import type { AstNodeId } from "../domain/diagram/node-id";

export const TOPOLOGY_MARGIN = 32;
export const TOPOLOGY_NODE_WIDTH = 156;
export const TOPOLOGY_NODE_HEIGHT = 42;
export const TOPOLOGY_COLUMN_GAP = 100;
export const TOPOLOGY_ROW_GAP = 28;
export const TOPOLOGY_EDGE_LABEL_HEIGHT = 22;

export interface TopologyNodeLayout {
  name: string;
  role: string;
  nodeId: AstNodeId;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TopologyEdgeLayout {
  connection: TopologyConnection;
  source: TopologyNodeLayout;
  target: TopologyNodeLayout;
  sourceIndex: number;
  targetIndex: number;
}

export interface TopologyLayout {
  width: number;
  height: number;
  title?: string;
  nodes: TopologyNodeLayout[];
  edges: TopologyEdgeLayout[];
}

/** Stable layered layout; cycles are placed in one safe residual layer. */
export function layoutTopology(topology: TopologyViewModel): TopologyLayout {
  const index = new Map(
    topology.services.map((service, position) => [service.name, position]),
  );
  const ranks = new Map(topology.services.map((service) => [service.name, 0]));
  const indegree = new Map(
    topology.services.map((service) => [service.name, 0]),
  );
  const successors = new Map<string, Set<string>>();
  for (const connection of topology.connections) {
    const values = successors.get(connection.producer) ?? new Set<string>();
    if (!values.has(connection.consumer)) {
      values.add(connection.consumer);
      indegree.set(
        connection.consumer,
        (indegree.get(connection.consumer) ?? 0) + 1,
      );
    }
    successors.set(connection.producer, values);
  }
  const ready = topology.services
    .filter((service) => indegree.get(service.name) === 0)
    .map((service) => service.name);
  const placed = new Set<string>();
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
    const name = ready.shift()!;
    if (placed.has(name)) continue;
    placed.add(name);
    for (const successor of successors.get(name) ?? []) {
      ranks.set(
        successor,
        Math.max(ranks.get(successor) ?? 0, (ranks.get(name) ?? 0) + 1),
      );
      const next = (indegree.get(successor) ?? 0) - 1;
      indegree.set(successor, next);
      if (next === 0) ready.push(successor);
    }
  }
  // A cycle has no meaningful causal layer; keeping its nodes in source order is
  // stable and avoids the layout pretending one member precedes another.
  const maxRank = Math.max(0, ...ranks.values());
  for (const service of topology.services) {
    if (!placed.has(service.name)) ranks.set(service.name, maxRank + 1);
  }

  const byRank = new Map<number, typeof topology.services>();
  for (const service of topology.services) {
    const values = byRank.get(ranks.get(service.name) ?? 0) ?? [];
    values.push(service);
    byRank.set(ranks.get(service.name) ?? 0, values);
  }
  const nodes: TopologyNodeLayout[] = [];
  const nodeByName = new Map<string, TopologyNodeLayout>();
  const rankCount = byRank.size === 0 ? 1 : Math.max(...byRank.keys()) + 1;
  for (const [rank, services] of byRank) {
    services.sort(
      (a, b) => (index.get(a.name) ?? 0) - (index.get(b.name) ?? 0),
    );
    services.forEach((service, row) => {
      const node = {
        name: service.name,
        role: service.role,
        nodeId: service.nodeId,
        x: TOPOLOGY_MARGIN + rank * (TOPOLOGY_NODE_WIDTH + TOPOLOGY_COLUMN_GAP),
        y: TOPOLOGY_MARGIN + row * (TOPOLOGY_NODE_HEIGHT + TOPOLOGY_ROW_GAP),
        width: TOPOLOGY_NODE_WIDTH,
        height: TOPOLOGY_NODE_HEIGHT,
      };
      nodes.push(node);
      nodeByName.set(service.name, node);
    });
  }

  const edges = topology.connections.flatMap((connection) => {
    const source = nodeByName.get(connection.producer);
    const target = nodeByName.get(connection.consumer);
    if (!source || !target) return [];
    return [
      {
        connection,
        source,
        target,
        sourceIndex: source.y,
        targetIndex: target.y,
      },
    ];
  });
  const maxRows = Math.max(
    1,
    ...[...byRank.values()].map((services) => services.length),
  );
  return {
    title: topology.title,
    nodes,
    edges,
    width:
      TOPOLOGY_MARGIN * 2 +
      rankCount * TOPOLOGY_NODE_WIDTH +
      Math.max(0, rankCount - 1) * TOPOLOGY_COLUMN_GAP,
    height:
      TOPOLOGY_MARGIN * 2 +
      maxRows * TOPOLOGY_NODE_HEIGHT +
      Math.max(0, maxRows - 1) * TOPOLOGY_ROW_GAP,
  };
}
