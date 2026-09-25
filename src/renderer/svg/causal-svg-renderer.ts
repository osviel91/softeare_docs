import type { CausalNodeId, CausalViewModel } from "../../domain/eventflow/causal-projection";
import type { CausalLayout, CausalNodeLayout } from "../../layout/causal-layout";

export interface CausalRenderOptions {
  selected?: CausalNodeId | null;
  theme?: "light" | "dark";
}

const colors = {
  light: { paper: "#fff", ink: "#0f172a", muted: "#64748b", line: "#94a3b8", message: "#e0f2fe", handler: "#ede9fe", effect: "#fef3c7", focus: "#0f766e", subdued: "#cbd5e1" },
  dark: { paper: "#0f172a", ink: "#e2e8f0", muted: "#94a3b8", line: "#64748b", message: "#164e63", handler: "#4c1d95", effect: "#713f12", focus: "#5eead4", subdued: "#334155" },
};

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function center(box: { x: number; y: number; width: number; height: number }) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
function kindLabel(type: CausalNodeLayout["type"]): string {
  return type === "message" ? "Event" : type[0].toUpperCase() + type.slice(1);
}
function neighbors(view: CausalViewModel, selected: CausalNodeId | null): Set<CausalNodeId> {
  if (!selected) return new Set(view.edges.flatMap((edge) => [edge.from, edge.to]));
  const ids = new Set<CausalNodeId>([selected]);
  for (const edge of view.edges) {
    if (edge.from === selected || edge.to === selected) {
      ids.add(edge.from);
      ids.add(edge.to);
    }
  }
  return ids;
}

export function causalCanvasSize(layout: CausalLayout) { return { width: layout.width, height: layout.height }; }

export function renderCausalToSvg(layout: CausalLayout, view: CausalViewModel, options: CausalRenderOptions = {}): string {
  const palette = colors[options.theme === "dark" ? "dark" : "light"];
  const relevant = neighbors(view, options.selected ?? null);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" font-family="Inter, system-ui, sans-serif" role="img" aria-label="Causal event flow">`, `<rect width="100%" height="100%" fill="${palette.paper}"/>`, `<defs><marker id="causal-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${palette.ink}"/></marker></defs>`];
  if (layout.title) parts.push(`<text x="28" y="24" fill="${palette.ink}" font-size="16" font-weight="700">${esc(layout.title)}</text>`);
  for (const { edge, from, to } of layout.edges) {
    const start = center(from); const end = center(to);
    const dim = options.selected !== null && options.selected !== undefined && (!relevant.has(edge.from) || !relevant.has(edge.to));
    const dashed = edge.type === "HANDLER_HAS_EFFECT" ? ` stroke-dasharray="5 4"` : "";
    const label = edge.type === "MESSAGE_HANDLED_BY_HANDLER" ? "handled by" : edge.type === "HANDLER_CAUSES_MESSAGE" ? "causes" : "effect";
    parts.push(`<g class="causal-edge${dim ? " is-subdued" : ""}" aria-label="${label}"><path d="M${start.x} ${start.y} C${start.x + 32} ${start.y}, ${end.x - 32} ${end.y}, ${end.x} ${end.y}" fill="none" stroke="${dim ? palette.subdued : palette.line}" stroke-width="${dim ? 1 : 1.8}"${dashed} marker-end="url(#causal-arrow)"/></g>`);
  }
  for (const node of layout.nodes) {
    const dim = options.selected !== null && options.selected !== undefined && !relevant.has(node.id);
    const selected = options.selected === node.id;
    const fill = node.type === "message" ? palette.message : node.type === "handler" ? palette.handler : palette.effect;
    const message = node.type === "message" ? view.messages.find((item) => item.id === node.id) : undefined;
    const radius = node.type === "message" ? 18 : node.type === "handler" ? 7 : 3;
    const label = `${kindLabel(node.type)}: ${node.label}`;
    parts.push(`<g data-causal-id="${esc(node.id)}"${node.sourceNodeIds[0] ? ` data-node-id="${esc(node.sourceNodeIds[0])}"` : ""} tabindex="0" role="button" aria-label="${esc(label)}" class="causal-node${selected ? " is-selected" : ""}${dim ? " is-subdued" : ""}"><rect x="${node.box.x}" y="${node.box.y}" width="${node.box.width}" height="${node.box.height}" rx="${radius}" fill="${fill}" stroke="${selected ? palette.focus : palette.ink}" stroke-width="${selected ? 3 : 1.5}"${dim ? ` opacity="0.35"` : ""}/><text x="${node.box.x + 12}" y="${node.box.y + 17}" fill="${palette.muted}" font-size="10" font-weight="700" letter-spacing=".08em">${kindLabel(node.type).toUpperCase()}${message ? ` · ${message.provenance}` : ""}</text><text x="${node.box.x + 12}" y="${node.box.y + 32}" fill="${palette.ink}" font-size="13">${esc(node.label)}</text></g>`);
  }
  parts.push("</svg>");
  return parts.join("");
}
