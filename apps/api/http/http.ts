/**
 * The HTTP surface, as plain data (ADR-040).
 *
 * Routing is decided by a pure function over a {@link ServerRequest} — method,
 * path, query, headers, body — and produces a {@link ServerResponse}. `node:http`
 * appears in exactly one place (`http-server.ts`), which is what lets the whole
 * API be tested by calling `handle(...)` with a plain object: no port, no
 * listener, no fetch, no test server.
 *
 * Cookies are handled here rather than with a dependency, for the same reason
 * the ZIP codec and the MCP protocol are owned: it is a small, fully specified
 * format, and owning it keeps the security-relevant parsing visible.
 */

/** A parsed request. */
export interface ServerRequest {
  method: string;
  /** The path, already decoded, without the query string. */
  path: string;
  /** Query parameters, first value wins. */
  query: Readonly<Record<string, string>>;
  /** Header names lower-cased. */
  headers: Readonly<Record<string, string>>;
  /** Parsed cookies. */
  cookies: Readonly<Record<string, string>>;
  /** The raw body, or `null` when the request has none. */
  body: string | null;
  /** The client address, for logs. Never used for authorization. */
  remoteAddress?: string;
}

/** One response header. */
export interface ResponseHeader {
  name: string;
  value: string;
}

/** A response to write. */
export interface ServerResponse {
  status: number;
  headers: ResponseHeader[];
  /** The body as text; the caller sets the content type. */
  body: string;
}

/** A handler for one route. */
export type RouteHandler = (request: ServerRequest) => Promise<ServerResponse>;

/** Render a JSON response. */
export function json(
  status: number,
  body: unknown,
  headers: readonly ResponseHeader[] = [],
): ServerResponse {
  return {
    status,
    headers: [
      { name: "content-type", value: "application/json; charset=utf-8" },
      ...headers,
    ],
    body: JSON.stringify(body),
  };
}

/** Render a plain-text response. */
export function text(
  status: number,
  body: string,
  headers: readonly ResponseHeader[] = [],
): ServerResponse {
  return {
    status,
    headers: [
      { name: "content-type", value: "text/plain; charset=utf-8" },
      ...headers,
    ],
    body,
  };
}

/** Render a redirect. */
export function redirect(location: string, status = 302): ServerResponse {
  return {
    status,
    headers: [
      { name: "location", value: location },
      { name: "cache-control", value: "no-store" },
    ],
    body: "",
  };
}

/** Render the standard error body for a status. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown,
  headers: readonly ResponseHeader[] = [],
): ServerResponse {
  return json(
    status,
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    headers,
  );
}

/** A `Set-Cookie` header value. */
export function cookie(
  name: string,
  value: string,
  options: {
    maxAgeSeconds?: number;
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
  } = {},
): ResponseHeader {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  return { name: "set-cookie", value: parts.join("; ") };
}

/** A `Set-Cookie` header that clears a cookie. */
export function clearCookie(
  name: string,
  options: { path?: string } = {},
): ResponseHeader {
  return cookie(name, "", {
    maxAgeSeconds: 0,
    path: options.path ?? "/",
    sameSite: "Lax",
  });
}

/**
 * Parse a `Cookie` header.
 *
 * Deliberately forgiving: an unparseable pair is skipped rather than failing the
 * request, because a stray cookie from another application on the same host must
 * not break login. A value without `=` is taken as an empty name and ignored.
 */
export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name === "") continue;
    const raw = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      // A malformed escape is a malformed cookie; keep its bytes rather than
      // throwing while parsing a header.
      cookies[name] = raw;
    }
  }
  return cookies;
}

/** Parse a query string into its parameters. */
export function parseQuery(search: string): Record<string, string> {
  const query: Record<string, string> = {};
  const body = search.startsWith("?") ? search.slice(1) : search;
  if (body === "") return query;
  for (const part of body.split("&")) {
    if (part === "") continue;
    const index = part.indexOf("=");
    const name = decodeURIComponent(index === -1 ? part : part.slice(0, index));
    const value = index === -1 ? "" : decodeURIComponent(part.slice(index + 1));
    if (!(name in query)) query[name] = value;
  }
  return query;
}

/** Headers a browser-facing JSON API should always send. */
export const SECURITY_HEADERS: readonly ResponseHeader[] = [
  { name: "x-content-type-options", value: "nosniff" },
  { name: "referrer-policy", value: "no-referrer" },
  { name: "cache-control", value: "no-store" },
];

/** Add the standard security headers to a response, without duplicating one. */
export function withSecurityHeaders(response: ServerResponse): ServerResponse {
  const present = new Set(
    response.headers.map((header) => header.name.toLowerCase()),
  );
  const added = SECURITY_HEADERS.filter(
    (header) => !present.has(header.name.toLowerCase()),
  );
  return { ...response, headers: [...response.headers, ...added] };
}
