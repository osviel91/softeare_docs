/**
 * Observability for the MCP service (Phase 6 §41–43, §45).
 *
 * Three concerns, one module, because they share a rule: **never record a
 * secret and never use an unbounded label.**
 *
 * - **Structured logs.** One JSON object per line, with `event`, `requestId`,
 *   `traceId` and the actor. A document's contents and an `Authorization` header
 *   are never part of an entry — the redaction is a property of the type, not a
 *   convention a caller has to remember.
 * - **Trace context.** A W3C `traceparent`/`tracestate` pair is read from the
 *   request and threaded through the tool call, so the trace can follow agent →
 *   MCP → application → repository. When a client sends nothing, a root context
 *   is generated.
 * - **Metrics.** Counters and a small duration histogram, with labels drawn from
 *   a closed set (method, tool, class, outcome). `projectId`, `resourceId`,
 *   `userId` and `credentialId` are *never* labels: they are unbounded, and one
 *   series per user is how a metrics backend falls over.
 */
import { randomBytes } from "node:crypto";

/** The closed vocabulary a metric label may use. */
export interface McpMetricLabels {
  method?: string;
  tool?: string;
  class?: string;
  outcome?: string;
  reason?: string;
}

/** One structured log entry. */
export interface LogEntry {
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  requestId?: string;
  traceId?: string;
  method?: string;
  tool?: string;
  durationMs?: number;
  actorType?: string;
  /** The actor's id (agent id or user id). An identifier, never a secret. */
  actorId?: string;
  /** The credential id. An identifier, never the token. */
  credentialId?: string;
  subjectUserId?: string;
  projectId?: string;
  result?: string;
  message?: string;
}

/** A structured logger. Injectable so a test can capture lines. */
export interface McpLogger {
  log(entry: LogEntry): void;
}

/** Write redacted JSON lines to a stream. */
export function createJsonLogger(
  write: (line: string) => void = (line) => process.stdout.write(line),
): McpLogger {
  return {
    log(entry) {
      const line = JSON.stringify({
        time: new Date().toISOString(),
        level: entry.level ?? "info",
        ...redact(entry as unknown as Record<string, unknown>),
      });
      write(`${line}\n`);
    },
  };
}

/** Names that must never appear in a log entry. */
const FORBIDDEN_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "secret",
  "password",
  "content",
  "body",
  "pat",
];

/**
 * Strip anything that could carry a credential or a document body.
 *
 * A deny-list rather than an allow-list is the wrong shape for security in
 * general, but here it guards a *typed* `LogEntry` whose fields are all known
 * identifiers, so it only has to catch a caller who spread an unknown object in.
 */
function redact(entry: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
      clean[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string" && value.length > 512) {
      clean[key] = `${value.slice(0, 512)}…[truncated]`;
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

/** A W3C trace context. */
export interface TraceContext {
  traceId: string;
  parentSpanId: string | null;
  traceparent: string | null;
  tracestate: string | null;
}

/** The `_meta` key a modern client may carry trace context in. */
export const META_TRACEPARENT = "traceparent";
export const META_TRACESTATE = "tracestate";

/** Whether a 32-hex-character trace id is well formed. */
function isTraceId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value) && !/^0{32}$/.test(value);
}

/** Whether a 16-hex-character span id is well formed. */
function isSpanId(value: string): boolean {
  return /^[0-9a-f]{16}$/i.test(value) && !/^0{16}$/.test(value);
}

/** Parse a `traceparent` value, or `null` when it is malformed. */
export function parseTraceparent(
  value: string | undefined,
): { traceId: string; spanId: string } | null {
  if (value === undefined) return null;
  const parts = value.trim().split("-");
  if (parts.length < 4) return null;
  const [, traceId, spanId] = parts;
  if (!isTraceId(traceId) || !isSpanId(spanId)) return null;
  return { traceId: traceId.toLowerCase(), spanId: spanId.toLowerCase() };
}

/**
 * Resolve the trace context for a request.
 *
 * Precedence is HTTP header first, then the MCP `_meta` representation, then a
 * fresh root context. A malformed `traceparent` is ignored rather than refused:
 * a client with a broken tracer should still be able to call a tool, and the
 * server generates its own context so the call is still traceable.
 */
export function traceContextOf(
  headers: Readonly<Record<string, string>>,
  meta?: Record<string, unknown> | null,
): TraceContext {
  const headerValue =
    headers.traceparent ??
    (typeof meta?.[META_TRACEPARENT] === "string"
      ? (meta[META_TRACEPARENT] as string)
      : undefined);
  const tracestate =
    headers.tracestate ??
    (typeof meta?.[META_TRACESTATE] === "string"
      ? (meta[META_TRACESTATE] as string)
      : undefined);
  const parsed = parseTraceparent(headerValue);
  if (parsed !== null) {
    return {
      traceId: parsed.traceId,
      parentSpanId: parsed.spanId,
      traceparent: headerValue ?? null,
      tracestate: tracestate ?? null,
    };
  }
  return {
    traceId: randomBytes(16).toString("hex"),
    parentSpanId: null,
    traceparent: null,
    tracestate: tracestate ?? null,
  };
}

/** A counter series. */
interface Counter {
  labels: string;
  value: number;
}

/** The metric names the service exposes. Bounded, stable, documented. */
export const METRIC_NAMES = [
  "mcp_requests_total",
  "mcp_request_duration_seconds",
  "mcp_tool_calls_total",
  "mcp_tool_errors_total",
  "auth_failures_total",
  "rate_limit_rejections_total",
  "workspace_mutation_failures_total",
  "workspace_compensation_total",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/** A minimal Prometheus-text metrics registry. */
export class Metrics {
  private readonly counters = new Map<string, Counter>();

  /** Increment a counter. */
  increment(name: MetricName, labels: McpMetricLabels = {}, by = 1): void {
    const drawn = drawLabels(labels);
    const key = `${name}{${drawn}}`;
    const existing = this.counters.get(key);
    if (existing) existing.value += by;
    else this.counters.set(key, { labels: drawn, value: by });
  }

  /** Render every counter in the Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    lines.push("# HELP mcp_requests_total MCP HTTP requests handled.");
    lines.push("# TYPE mcp_requests_total counter");
    for (const [key, counter] of [...this.counters].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const name = key.slice(0, key.indexOf("{"));
      lines.push(`${name}{${counter.labels}} ${counter.value}`);
    }
    return `${lines.join("\n")}\n`;
  }

  /** Reset every counter, for a test that wants a clean slate. */
  reset(): void {
    this.counters.clear();
  }
}

/** Draw only the labels in the closed vocabulary, in a stable order. */
function drawLabels(labels: McpMetricLabels): string {
  const parts: string[] = [];
  for (const key of ["method", "tool", "class", "outcome", "reason"] as const) {
    const value = labels[key];
    if (value === undefined) continue;
    parts.push(`${key}="${escapeLabel(value)}"`);
  }
  return parts.join(",");
}

/** Escape a label value for the Prometheus text format. */
function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/** Observability bundled for one request. */
export interface Observability {
  logger: McpLogger;
  metrics: Metrics;
}
