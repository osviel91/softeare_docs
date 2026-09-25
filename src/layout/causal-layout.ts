import type {
  CausalEdge,
  CausalNodeId,
  CausalViewModel,
} from "../domain/eventflow/causal-projection";
import { estimateTextWidth, wrapText } from "./text";

export interface CausalBox { x: number; y: number; width: number; height: number }
export interface CausalNodeLayout {
  id: CausalNodeId;
  type: "message" | "handler" | "effect";
  label: string;
  box: CausalBox;
  sourceNodeIds: string[];
  lines: string[];
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
const NODE_MIN_WIDTH = 180;
const NODE_MAX_WIDTH = 260;
const NODE_LINE_HEIGHT = 15;
const NODE_PADDING_Y = 14;
const EFFECT_MIN_WIDTH = 170;
const EFFECT_MAX_WIDTH = 250;
const EFFECT_LINE_HEIGHT = 14;
const EFFECT_PADDING_Y = 12;

function width(label: string, type: CausalNodeLayout["type"]): number {
  return Math.min(
    type === "effect" ? EFFECT_MAX_WIDTH : NODE_MAX_WIDTH,
    Math.max(type === "effect" ? EFFECT_MIN_WIDTH : NODE_MIN_WIDTH, estimateTextWidth(label) + 28),
  );
}

function nodeGeometry(label: string, type: CausalNodeLayout["type"]): { width: number; height: number; lines: string[] } {
  const boxWidth = width(label, type);
  const lines = wrapText(label, boxWidth - 24, type === "effect" ? 12 : 13);
  const lineHeight = type === "effect" ? EFFECT_LINE_HEIGHT : NODE_LINE_HEIGHT;
  const padding = type === "effect" ? EFFECT_PADDING_Y : NODE_PADDING_Y;
  return { width: boxWidth, height: padding + lineHeight * Math.max(1, lines.length) + (type === "effect" ? 18 : 18), lines };
}

/** Pure, finite, deterministic geometry for explicit causal relationships. */
export function layoutCausalView(view: CausalViewModel): CausalLayout {
  const main = [
    ...view.messages.map((item) => ({ id: item.id, type: "message" as const, label: item.name, sourceNodeIds: item.sourceNodeIds })),
    ...view.handlers.map((item) => ({ id: item.id, type: "handler" as const, label: item.displayName, sourceNodeIds: item.sourceNodeIds })),
  ];
  const rank = new Map<CausalNodeId, number>();
  const visiting = new Set<CausalNodeId>();
  const incoming = new Map<CausalNodeId, CausalNodeId[]>();
  for (const item of main) incoming.set(item.id, []);
  for (const edge of view.edges) {
    if (edge.type !== "HANDLER_HAS_EFFECT") incoming.get(edge.to)?.push(edge.from);
  }
  const getRank = (id: CausalNodeId): number => {
    if (rank.has(id)) return rank.get(id)!;
    if (visiting.has(id)) return 0; // back edge: keep cycles finite
    visiting.add(id);
    const value = Math.max(0, ...(incoming.get(id) ?? []).map(getRank).map((item) => item + 1));
    visiting.delete(id);
    rank.set(id, value);
    return value;
  };
  main.forEach((item) => getRank(item.id));
  const columns = new Map<number, typeof main>();
  for (const item of main) {
    const column = columns.get(rank.get(item.id)!) ?? [];
    column.push(item);
    columns.set(rank.get(item.id)!, column);
  }
  const boxes = new Map<CausalNodeId, CausalBox>();
  let x = MARGIN;
  let maxY = MARGIN;
  for (const column of [...columns.keys()].sort((a, b) => a - b).map((key) => columns.get(key)!)) {
    const columnWidth = Math.max(...column.map((item) => nodeGeometry(item.label, item.type).width));
    let y = MARGIN + (view.title ? 28 : 0);
    for (const item of column) {
      const geometry = nodeGeometry(item.label, item.type);
      boxes.set(item.id, { x, y, width: columnWidth, height: geometry.height });
      y += geometry.height + GAP_Y;
    }
    maxY = Math.max(maxY, y - GAP_Y + MARGIN);
    x += columnWidth + GAP_X;
  }
  // Effects are owned annotations, not another causal rank. Place them under
  // their handler and move them down on collision with the main graph.
  const effects = view.effects.map((item) => ({ id: item.id, type: "effect" as const, label: item.description, sourceNodeIds: item.sourceNodeIds }));
  for (const effect of effects) {
    const handler = boxes.get(view.effects.find((item) => item.id === effect.id)!.handlerId);
    if (!handler) continue;
    const geometry = nodeGeometry(effect.label, "effect");
    const box = { x: handler.x + (handler.width - geometry.width) / 2, y: handler.y + handler.height + GAP_Y, width: geometry.width, height: geometry.height };
    while ([...boxes.values()].some((other) => overlaps(box, other))) box.y += geometry.height + GAP_Y;
    boxes.set(effect.id, box);
    maxY = Math.max(maxY, box.y + box.height + MARGIN);
  }
  const all = [...main, ...effects];
  return {
    width: Math.max(MARGIN * 2, x - GAP_X + MARGIN, ...[...boxes.values()].map((box) => box.x + box.width + MARGIN)),
    height: Math.max(MARGIN * 2, maxY),
    ...(view.title === undefined ? {} : { title: view.title }),
    nodes: all.map((item) => ({ ...item, box: boxes.get(item.id)!, lines: nodeGeometry(item.label, item.type).lines })),
    edges: view.edges.flatMap((edge) => {
      const from = boxes.get(edge.from);
      const to = boxes.get(edge.to);
      return from && to ? [{ edge, from, to }] : [];
    }),
  };
}

function overlaps(left: CausalBox, right: CausalBox): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y;
}
