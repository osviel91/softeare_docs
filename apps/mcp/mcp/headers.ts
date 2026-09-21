/**
 * Modern MCP request headers (Phase 6 §7, §36).
 *
 * The 2026-era Streamable HTTP profile puts the routing-relevant parts of a
 * request into headers as well as the body:
 *
 * ```text
 * MCP-Protocol-Version: 2026-07-28
 * Mcp-Method: tools/call
 * Mcp-Name: update_resource
 * ```
 *
 * so a reverse proxy, WAF, rate limiter or observability agent can classify a
 * request without parsing JSON. The SDK this service uses validates
 * `MCP-Protocol-Version` itself, so this module does not touch it. The SDK does
 * **not** know `Mcp-Method` or `Mcp-Name`, so the agreement check lives here —
 * and it fails closed, because a header that disagrees with the body is either a
 * broken client or an attempt to be metered as one kind of traffic while
 * performing another.
 *
 * ## Compatibility
 *
 * A header whose *value* disagrees with the body is refused. A request that
 * omits the headers entirely is accepted: the installed SDK implements protocol
 * `2025-11-25`, which does not require them, and refusing a request that simply
 * predates the header profile would break every current client. When the headers
 * *are* present, they must be right.
 */

/** The header names this module understands, lower-cased. */
export const MCP_METHOD_HEADER = "mcp-method";
export const MCP_NAME_HEADER = "mcp-name";

/** A header check failure, shaped as the JSON-RPC error it becomes. */
export interface HeaderRefusal {
  ok: false;
  status: number;
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

/** The successful outcome. */
export interface HeaderAccepted {
  ok: true;
  /** The method the headers named, when they named one. */
  method: string | null;
  /** The tool or resource name the headers named, when they named one. */
  name: string | null;
}

/** JSON-RPC `Invalid Request`. */
const INVALID_REQUEST = -32600;

/** Read one header, comparing case-insensitively. */
function headerOf(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** The method a parsed JSON-RPC message names, or `null`. */
function methodOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const method = (body as Record<string, unknown>).method;
  return typeof method === "string" ? method : null;
}

/**
 * The name a parsed request carries: a tool name for `tools/call`, a URI for a
 * resource read, absent otherwise.
 */
function nameOf(body: unknown, method: string | null): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const params = (body as Record<string, unknown>).params;
  if (typeof params !== "object" || params === null) return null;
  const record = params as Record<string, unknown>;
  if (method === "tools/call" && typeof record.name === "string") {
    return record.name;
  }
  if (
    (method === "resources/read" || method === "resources/subscribe") &&
    typeof record.uri === "string"
  ) {
    return record.uri;
  }
  return null;
}

/**
 * Validate `Mcp-Method` / `Mcp-Name` against the parsed body.
 *
 * @param headers - The lower-cased request headers.
 * @param body - The parsed JSON-RPC message, or `null` when there is no body.
 */
export function checkModernHeaders(
  headers: Readonly<Record<string, string>>,
  body: unknown,
): HeaderAccepted | HeaderRefusal {
  const rawMethod = headerOf(headers, MCP_METHOD_HEADER);
  const rawName = headerOf(headers, MCP_NAME_HEADER);
  if (rawMethod === undefined && rawName === undefined) {
    return { ok: true, method: null, name: null };
  }

  const namedMethod = rawMethod?.trim() ?? null;
  const namedName = rawName?.trim() ?? null;

  // A name without a method cannot be classified, and a batch cannot be
  // described by one method/name pair. Both are refusals rather than guesses.
  if (namedMethod === null && namedName !== null) {
    return {
      ok: false,
      status: 400,
      code: INVALID_REQUEST,
      message: `${MCP_NAME_HEADER} requires ${MCP_METHOD_HEADER}.`,
    };
  }
  if (Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      code: INVALID_REQUEST,
      message: `A JSON-RPC batch must not carry ${MCP_METHOD_HEADER} or ${MCP_NAME_HEADER}: one pair cannot describe several messages.`,
    };
  }

  const method = methodOf(body);
  if (namedMethod !== null && namedMethod !== method) {
    return {
      ok: false,
      status: 400,
      code: INVALID_REQUEST,
      message: `${MCP_METHOD_HEADER} disagrees with the request body.`,
      data: { header: namedMethod, body: method },
    };
  }

  const name = nameOf(body, method);
  if (namedName !== null && namedName !== name) {
    return {
      ok: false,
      status: 400,
      code: INVALID_REQUEST,
      message: `${MCP_NAME_HEADER} disagrees with the request body.`,
      data: { header: namedName, body: name },
    };
  }

  return { ok: true, method: namedMethod, name: namedName };
}
