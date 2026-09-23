import type {
  TopologyLayout,
  TopologyNodeLayout,
} from "../../layout/topology-layout";

export interface TopologyRenderOptions {
  theme?: "light" | "dark";
  background?: string;
  includeTitle?: boolean;
  padding?: number;
}

const palette = {
  light: {
    paper: "#ffffff",
    node: "#eef2f7",
    ink: "#0f172a",
    line: "#64748b",
    edge: "#334155",
    muted: "#475569",
  },
  dark: {
    paper: "#0f172a",
    node: "#1e293b",
    ink: "#e2e8f0",
    line: "#94a3b8",
    edge: "#cbd5e1",
    muted: "#cbd5e1",
  },
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pad(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

export function topologyCanvasSize(layout: TopologyLayout, padding = 0) {
  const extra = pad(padding) * 2;
  return {
    width: Math.max(64, layout.width) + extra,
    height: Math.max(64, layout.height) + extra,
  };
}

function node(node: TopologyNodeLayout, colors: typeof palette.light): string {
  return `<g class="topology-node" data-node-id="${escapeXml(node.nodeId)}" data-service-name="${escapeXml(node.name)}"><title>${escapeXml(node.name)} (${escapeXml(node.role)})</title><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" fill="${colors.node}" stroke="${colors.line}" stroke-width="1.5"/><text x="${node.x + node.width / 2}" y="${node.y + 19}" text-anchor="middle" font-size="13" font-weight="600" fill="${colors.ink}">${escapeXml(node.name)}</text><text x="${node.x + node.width / 2}" y="${node.y + 34}" text-anchor="middle" font-size="10" fill="${colors.muted}">${escapeXml(node.role)}</text></g>`;
}

function edge(
  layoutEdge: TopologyLayout["edges"][number],
  colors: typeof palette.light,
): string {
  const { connection, source, target } = layoutEdge;
  const startX = source.x + source.width;
  const startY = source.y + source.height / 2;
  const endX = target.x;
  const endY = target.y + target.height / 2;
  const bend = source === target ? 34 : Math.max(28, (endX - startX) / 2);
  const path =
    source === target
      ? `M ${startX} ${startY} C ${startX + bend} ${startY - 34}, ${startX + bend} ${startY + 34}, ${startX} ${startY + 10}`
      : `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
  const label = `${connection.events.length} event${connection.events.length === 1 ? "" : "s"}`;
  const labelX = (startX + endX) / 2;
  const labelY = (startY + endY) / 2 - 5;
  return `<g class="topology-edge" data-connection-id="${escapeXml(connection.id)}" aria-label="${escapeXml(connection.producer)} to ${escapeXml(connection.consumer)}: ${escapeXml(label)}"><path d="${path}" fill="none" stroke="${colors.edge}" stroke-width="2" marker-end="url(#topology-arrow)"/><text x="${labelX}" y="${labelY}" text-anchor="middle" font-size="11" fill="${colors.muted}">${escapeXml(label)}</text></g>`;
}

export function renderTopologyToSvg(
  layout: TopologyLayout,
  options: TopologyRenderOptions = {},
): string {
  const colors = palette[options.theme === "dark" ? "dark" : "light"];
  const padding = pad(options.padding);
  const size = topologyCanvasSize(layout, padding);
  const background =
    options.background === "transparent"
      ? ""
      : `<rect width="${size.width}" height="${size.height}" fill="${escapeXml(options.background ?? colors.paper)}"/>`;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}" role="img" aria-label="Event topology${layout.title ? `: ${escapeXml(layout.title)}` : ""}" font-family="Inter, system-ui, sans-serif">`,
    `<defs><marker id="topology-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="${colors.edge}"/></marker></defs>`,
    background,
  ];
  if (padding > 0)
    parts.push(`<g transform="translate(${padding}, ${padding})">`);
  if (options.includeTitle !== false && layout.title)
    parts.push(
      `<text x="${layout.width / 2}" y="20" text-anchor="middle" font-size="16" font-weight="600" fill="${colors.ink}">${escapeXml(layout.title)}</text>`,
    );
  parts.push(
    ...layout.edges.map((entry) => edge(entry, colors)),
    ...layout.nodes.map((entry) => node(entry, colors)),
  );
  if (padding > 0) parts.push("</g>");
  parts.push("</svg>");
  return parts.join("");
}
