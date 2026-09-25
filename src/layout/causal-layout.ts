import type {
  CausalEdge,
  CausalNodeId,
  CausalViewModel,
} from "../domain/eventflow/causal-projection";

export interface CausalBox { x: number; y: number; width: number; height: number }
export interface CausalNodeLayout {
  id: CausalNodeId;
  type: "message" | "handler" | "effect";
  label: string;
  box: CausalBox;
  sourceNodeIds: string[];
}
export interface CausalEdgeLayout { edge: CausalEdge; from: CausalBox; to: CausalBox }
export interface CausalLayout {
  width: number;
  height: number;
  title?: string;
  nodes: CausalNodeLayout[];
  edges: CausalEdgeLayout[];
}

const GAP_X = 72;
const GAP_Y = 28;
const MARGIN = 28;
const NODE_HEIGHT = 42;
const EFFECT_HEIGHT = 32;

function width(label: string, type: CausalNodeLayout["type"]): number {
  return Math.max(type === "effect" ? 150 : 170, label.length * 7 + 28);
}

/** Pure, finite, deterministic geometry for explicit causal relationships. */
export function layoutCausalView(view: CausalViewModel): CausalLayout {
  const all = [
    ...view.messages.map((item) => ({ id: item.id, type: "message" as const, label: item.name, sourceNodeIds: item.sourceNodeIds })),
    ...view.handlers.map((item) => ({ id: item.id, type: "handler" as const, label: item.displayName, sourceNodeIds: item.sourceNodeIds })),
    ...view.effects.map((item) => ({ id: item.id, type: "effect" as const, label: item.description, sourceNodeIds: item.sourceNodeIds })),
  ];
  const rank = new Map<CausalNodeId, number>();
  const visiting = new Set<CausalNodeId>();
  const incoming = new Map<CausalNodeId, CausalNodeId[]>();
  for (const item of all) incoming.set(item.id, []);
  for (const edge of view.edges) incoming.get(edge.to)?.push(edge.from);
  const getRank = (id: CausalNodeId): number => {
    if (rank.has(id)) return rank.get(id)!;
    if (visiting.has(id)) return 0; // back edge: keep cycles finite
    visiting.add(id);
    const value = Math.max(0, ...(incoming.get(id) ?? []).map(getRank).map((item) => item + 1));
    visiting.delete(id);
    rank.set(id, value);
    return value;
  };
  all.forEach((item) => getRank(item.id));
  const columns = new Map<number, typeof all>();
  for (const item of all) {
    const column = columns.get(rank.get(item.id)!) ?? [];
    column.push(item);
    columns.set(rank.get(item.id)!, column);
  }
  const boxes = new Map<CausalNodeId, CausalBox>();
  let x = MARGIN;
  let maxY = MARGIN;
  for (const column of [...columns.keys()].sort((a, b) => a - b).map((key) => columns.get(key)!)) {
    const columnWidth = Math.max(...column.map((item) => width(item.label, item.type)));
    let y = MARGIN + (view.title ? 28 : 0);
    for (const item of column) {
      const height = item.type === "effect" ? EFFECT_HEIGHT : NODE_HEIGHT;
      boxes.set(item.id, { x, y, width: columnWidth, height });
      y += height + GAP_Y;
    }
    maxY = Math.max(maxY, y - GAP_Y + MARGIN);
    x += columnWidth + GAP_X;
  }
  return {
    width: Math.max(MARGIN * 2, x - GAP_X + MARGIN),
    height: Math.max(MARGIN * 2, maxY),
    ...(view.title === undefined ? {} : { title: view.title }),
    nodes: all.map((item) => ({ ...item, box: boxes.get(item.id)! })),
    edges: view.edges.flatMap((edge) => {
      const from = boxes.get(edge.from);
      const to = boxes.get(edge.to);
      return from && to ? [{ edge, from, to }] : [];
    }),
  };
}
