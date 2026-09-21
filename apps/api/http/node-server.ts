/**
 * The Node HTTP transport (ADR-040).
 *
 * The only file in the API that imports `node:http`. It turns an
 * `IncomingMessage` into a {@link ServerRequest}, hands it to the router, and
 * writes the {@link ServerResponse} back. Everything interesting — routing,
 * authentication, authorization, use cases — happens above this line and is
 * testable without it.
 *
 * Two operational decisions:
 *
 * - **A body limit.** A documentation API has no reason to accept a large
 *   upload, and an unbounded body is a denial-of-service vector, so the reader
 *   stops at {@link MAX_BODY_BYTES} and the request is refused.
 * - **Errors never leak internals.** An unexpected throw becomes a 500 with a
 *   correlation id and nothing else; the detail goes to the log, not the client.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  errorResponse,
  parseCookies,
  parseQuery,
  type ServerRequest,
  type ServerResponse as ApiResponse,
} from "./http";
import type { Router } from "./router";

/** The largest request body the API accepts, in bytes. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** A request that carried more than {@link MAX_BODY_BYTES}. */
export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`The request body exceeds the ${limit} byte limit.`);
    this.name = "BodyTooLargeError";
  }
}

/** Read a request body, refusing one that is too large. */
export async function readBody(
  stream: AsyncIterable<Buffer | string>,
  limit = MAX_BODY_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > limit) throw new BodyTooLargeError(limit);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Lower-case the header names of an incoming request. */
export function normalizeHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[name.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : value;
  }
  return normalized;
}

/** Branch on a request's socket, since `IncomingMessage` does not declare it. */
function remoteAddressOf(request: IncomingMessage): string | undefined {
  const socket = (request as { socket?: { remoteAddress?: string } }).socket;
  return socket?.remoteAddress;
}

/** Turn an incoming message into a {@link ServerRequest}. */
export async function toServerRequest(
  request: IncomingMessage,
): Promise<ServerRequest> {
  const raw = request.url ?? "/";
  const queryIndex = raw.indexOf("?");
  const rawPath = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const headers = normalizeHeaders(request.headers);
  const method = (request.method ?? "GET").toUpperCase();
  const body =
    method === "GET" || method === "HEAD" ? null : await readBody(request);
  const address = remoteAddressOf(request);
  return {
    method,
    path: decodeURIComponent(rawPath),
    query: parseQuery(queryIndex === -1 ? "" : raw.slice(queryIndex)),
    headers,
    cookies: parseCookies(headers.cookie),
    body,
    ...(address === undefined ? {} : { remoteAddress: address }),
  };
}

/** Write a {@link ApiResponse} to a Node response. */
export function writeResponse(
  response: ServerResponse,
  api: ApiResponse,
): void {
  response.statusCode = api.status;
  for (const header of api.headers) {
    response.setHeader(header.name, header.value);
  }
  response.end(api.body);
}

/** Options for the HTTP listener. */
export interface HttpServerOptions {
  router: Router;
  /** Called for every unexpected failure, with the correlation id. */
  onError?: (error: unknown, requestId: string) => void;
}

/**
 * A correlation id for a request.
 *
 * Taken from the client's `x-request-id` when present so a trace survives the
 * proxy, and generated otherwise. It is an opaque string, never used for
 * authorization, and it is what ties a log line to an audit row.
 */
export function correlationId(request: ServerRequest): string {
  const supplied = request.headers["x-request-id"];
  if (supplied !== undefined && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) {
    return supplied;
  }
  return `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** Build the Node HTTP server over a router. */
export function createHttpServer(options: HttpServerOptions): Server {
  const { router } = options;
  return createServer((incoming, outgoing) => {
    void (async () => {
      let requestId = "req_unknown";
      try {
        const request = await toServerRequest(incoming);
        requestId = correlationId(request);
        const response = await router.handle(request);
        response.headers.push({ name: "x-request-id", value: requestId });
        writeResponse(outgoing, response);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          writeResponse(
            outgoing,
            errorResponse(413, "payload_too_large", error.message),
          );
          return;
        }
        options.onError?.(error, requestId);
        writeResponse(
          outgoing,
          errorResponse(
            500,
            "internal_error",
            "The request could not be completed.",
            {
              requestId,
            },
          ),
        );
      }
    })();
  });
}
