import type { CausalEdge, CausalNodeId, CausalViewModel } from "../../domain/eventflow/causal-projection";
import type { CausalLayout, CausalNodeLayout } from "../../layout/causal-layout";

export interface CausalRenderOptions {
  selected?: CausalNodeId | null;
  theme?: "light" | "dark";
}

const colors = {
  light: { paper: "#fff", ink: "#0f172a", muted: "#64748b", line: "#94a3b8", message: "#e0f2fe", handler: "#ede9fe", effect: "#fef3c7", failure: "#fee2e2", retry: "#fce7f3", focus: "#0f766e", subdued: "#cbd5e1" },
  dark: { paper: "#0f172a", ink: "#e2e8f0", muted: "#94a3b8", line: "#64748b", message: "#164e63", handler: "#4c1d95", effect: "#713f12", failure: "#7f1d1d", retry: "#831843", focus: "#5eead4", subdued: "#334155" },
};

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function center(box: { x: number; y: number; width: number; height: number }) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
function kindLabel(type: CausalNodeLayout["type"], messageKind?: "event" | "command"): string {
  return type === "message" ? (messageKind === "command" ? "Command" : "Event") : type[0].toUpperCase() + type.slice(1);
}
function focusSets(view: CausalViewModel, selected: CausalNodeId | null): { immediate: Set<CausalNodeId>; upstream: Set<CausalNodeId>; downstream: Set<CausalNodeId> } {
  const immediate = new Set<CausalNodeId>();
  const upstream = new Set<CausalNodeId>();
  const downstream = new Set<CausalNodeId>();
  if (!selected) return { immediate, upstream, downstream };
  const visit = (direction: "upstream" | "downstream", start: CausalNodeId, result: Set<CausalNodeId>) => {
    for (const edge of view.edges) {
      const matches = direction === "upstream" ? edge.to === start : edge.from === start;
      const next = direction === "upstream" ? edge.from : edge.to;
      if (!matches || next === selected || result.has(next)) continue;
      result.add(next);
      visit(direction, next, result);
    }
  };
  for (const edge of view.edges) {
    if (edge.from === selected) immediate.add(edge.to);
    if (edge.to === selected) immediate.add(edge.from);
  }
  visit("upstream", selected, upstream);
  visit("downstream", selected, downstream);
  return { immediate, upstream, downstream };
}

function edgePath(edge: CausalEdge, from: { x: number; y: number; width: number; height: number }, to: { x: number; y: number; width: number; height: number }, index: number, effectCount = 1, groupOffset = 0): string {
  const start = center(from); const end = center(to);
  if (edge.type === "HANDLER_HAS_EFFECT") {
    const offset = effectCount > 1 ? (index - (effectCount - 1) / 2) * 16 : 0;
    const lane = start.x + offset + groupOffset;
    return `M${start.x} ${from.y + from.height} H${lane} V${to.y - 12} H${end.x} V${end.y}`;
  }
  const forward = to.x >= from.x;
  const startX = forward ? from.x + from.width : from.x;
  const endX = forward ? to.x : to.x + to.width;
  const lane = (startX + endX) / 2 + (index % 2) * 8;
  return `M${startX} ${start.y} H${lane} V${end.y} H${endX}`;
}

export function causalCanvasSize(layout: CausalLayout) { return { width: layout.width, height: layout.height }; }

export function renderCausalToSvg(layout: CausalLayout, view: CausalViewModel, options: CausalRenderOptions = {}): string {
  const palette = colors[options.theme === "dark" ? "dark" : "light"];
  const focus = focusSets(view, options.selected ?? null);
  const effectGroups = new Map(
    layout.effectGroups.map((group) => [group.handlerId, group.effectIds]),
  );
  const effectGroupOffsets = new Map(
    layout.effectGroups.map((group, index) => [group.handlerId, (index - (layout.effectGroups.length - 1) / 2) * 16]),
  );
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" font-family="Inter, system-ui, sans-serif" role="img" aria-label="Causal event flow">`, `<rect width="100%" height="100%" fill="${palette.paper}"/>`, `<defs><marker id="causal-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${palette.ink}"/></marker><marker id="causal-effect-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="none" stroke="${palette.ink}"/></marker></defs>`];
  const effectIndexes = new Map<CausalNodeId, number>();
  if (layout.title) parts.push(`<text x="28" y="24" fill="${palette.ink}" font-size="16" font-weight="700">${esc(layout.title)}</text>`);
  for (const [index, { edge, from, to }] of layout.edges.entries()) {
    const selected = options.selected ?? null;
    const connected = !selected || edge.from === selected || edge.to === selected || focus.immediate.has(edge.from) || focus.immediate.has(edge.to);
    const dim = Boolean(selected && !connected);
    const effect = edge.type === "HANDLER_HAS_EFFECT";
    const retry = edge.type === "FAILURE_RETRIED" || edge.type.startsWith("RETRY_");
    const dashed = effect || retry ? ` stroke-dasharray="5 4"` : "";
    const edgeClass = edge.type === "HANDLER_CAUSES_MESSAGE" ? " causes" : effect ? " effect" : retry ? " retry" : edge.type === "ENTITY_FAILED" ? " failure" : " handled-by";
    const pathClass = selected && focus.upstream.has(edge.from) && focus.upstream.has(edge.to)
      ? " is-upstream"
      : selected && focus.downstream.has(edge.from) && focus.downstream.has(edge.to)
        ? " is-downstream"
        : "";
    const label = edge.type === "MESSAGE_HANDLED_BY_HANDLER" ? "handled by" : edge.type === "HANDLER_CAUSES_MESSAGE" ? "causes" : edge.type === "ENTITY_FAILED" ? "fails" : retry ? "retry" : "effect";
    const group = effect ? effectGroups.get(edge.from) ?? [] : [];
    const pathIndex = effect ? (effectIndexes.get(edge.from) ?? 0) : index;
    if (effect) effectIndexes.set(edge.from, pathIndex + 1);
    parts.push(`<g class="causal-edge${edgeClass}${pathClass}${dim ? " is-subdued" : ""}" data-edge-type="${edge.type}" aria-label="${label}"><path d="${edgePath(edge, from, to, pathIndex, effect ? group.length : 1, effectGroupOffsets.get(edge.from) ?? 0)}" fill="none" stroke="${dim ? palette.subdued : palette.line}" stroke-width="${dim ? 1 : edge.type === "HANDLER_CAUSES_MESSAGE" ? 2.2 : 1.8}"${pathClass ? ` stroke-dasharray="${pathClass.includes("upstream") ? "7 3" : "3 3"}"` : dashed} marker-end="url(#${effect ? "causal-effect-arrow" : "causal-arrow"})"/></g>`);
  }
  for (const node of layout.nodes) {
    const dim = Boolean(options.selected && node.id !== options.selected && !focus.immediate.has(node.id) && !focus.upstream.has(node.id) && !focus.downstream.has(node.id));
    const selected = options.selected === node.id;
    const fill = node.type === "message" ? palette.message : node.type === "handler" ? palette.handler : node.type === "effect" ? palette.effect : node.type === "failure" ? palette.failure : palette.retry;
    const message = node.type === "message" ? view.messages.find((item) => item.id === node.id) : undefined;
    const radius = node.type === "message" ? 18 : node.type === "handler" ? 7 : node.type === "failure" ? 10 : 3;
    const label = `${kindLabel(node.type, message?.kind)}: ${node.label}`;
    const focusClass = selected ? " is-selected" : focus.immediate.has(node.id) ? " is-causal-neighbor" : focus.upstream.has(node.id) ? " is-upstream" : focus.downstream.has(node.id) ? " is-downstream" : "";
    const focusStroke = selected || focus.immediate.has(node.id) ? palette.focus : palette.ink;
    const focusDash = focus.upstream.has(node.id) ? ` stroke-dasharray="7 3"` : focus.downstream.has(node.id) ? ` stroke-dasharray="3 3"` : "";
    const details = message ? `${message.kind}, ${message.provenance}${message.initiation ? `, initiated ${message.initiation}` : ""}` : node.type === "effect" ? "supporting effect" : "handler responsibility";
    const lines = node.lines.length ? node.lines : [node.label];
    const text = lines.map((line, index) => `<tspan x="${node.box.x + 12}" dy="${index === 0 ? 0 : 15}">${esc(line)}</tspan>`).join("");
    parts.push(`<g data-causal-id="${esc(node.id)}"${node.sourceNodeIds[0] ? ` data-node-id="${esc(node.sourceNodeIds[0])}"` : ""} tabindex="0" role="button" aria-label="${esc(label)}" data-focus-detail="${esc(details)}" class="causal-node${focusClass}${dim ? " is-subdued" : ""}"><rect x="${node.box.x}" y="${node.box.y}" width="${node.box.width}" height="${node.box.height}" rx="${radius}" fill="${fill}" stroke="${focusStroke}" stroke-width="${selected ? 3 : 1.5}"${focusDash}${dim ? ` opacity="0.35"` : ""}/><text x="${node.box.x + 12}" y="${node.box.y + 17}" fill="${palette.muted}" font-size="10" font-weight="700" letter-spacing=".08em">${kindLabel(node.type, message?.kind).toUpperCase()}${message ? ` · ${message.provenance}${message.initiation ? ` · initiated ${message.initiation}` : ""}` : ""}</text><text x="${node.box.x + 12}" y="${node.box.y + 34}" fill="${palette.ink}" font-size="13">${text}</text></g>`);
  }
  parts.push("</svg>");
  return parts.join("");
}
