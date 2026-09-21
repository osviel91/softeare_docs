/**
 * The MCP service's Node HTTP adapter (Phase 6 §44, §48–49).
 *
 * The only file in the MCP host that imports `node:http`. It converts an
 * `IncomingMessage` into a web-standard `Request`, delegates to the shared
 * handler, and writes the `Response` back. Everything interesting — routing,
 * authentication, header validation, rate limiting, tool dispatch — happens
 * above this line and is exercised by the in-process protocol tests.
 *
 * ## Routes outside `/mcp`
 *
 * - `/health` — process liveness. No dependency is touched, so a database
 *   outage does not make the orchestrator kill a healthy process.
 * - `/ready` — readiness. Checks PostgreSQL and the project volume.
 * - `/metrics` — Prometheus text, when enabled.
 *
 * None of these require an MCP token: they are infrastructure probes, and the
 * network policy is what protects them. None of them discloses dependency detail
 * beyond "usable" or not (mission §44).
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import type { McpConfig } from "../config";
import type { Observability } from "../observability";
import { clientAddressOf } from "./proxies";

/** The synthetic header the adapter sets from the resolved client address. */
export const CLIENT_ADDRESS_HEADER = "x-sdm-client-address";

/** Options for the HTTP listener. */
export interface McpHttpServerOptions {
  config: McpConfig;
  observability: Observability;
  /** Handle one `/mcp` request. */
  handleMcp: (request: Request) => Promise<Response>;
  /** Whether the service is ready to serve. */
  ready: () => Promise<{ database: boolean; storage: boolean }>;
  /** Called for an unexpected failure, with the correlation id. */
  onError?: (error: unknown, requestId: string) => void;
}

/** Lower-case the header names of an incoming request. */
function normalizeHeaders(
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

/** The socket address, since `IncomingMessage` does not declare it. */
function remoteAddressOf(request: IncomingMessage): string | undefined {
  const socket = (request as { socket?: { remoteAddress?: string } }).socket;
  return socket?.remoteAddress;
}

/**
 * Build the canonical URL for a request.
 *
 * The origin comes from configuration, never from the client's `Host` header —
 * that is the mission's rule for resource identifiers, and it applies here so no
 * downstream code can be tricked into believing the service is someone else.
 */
function canonicalUrl(config: McpConfig, originalUrl: string): string {
  const base = new URL(config.publicUrl);
  const path = originalUrl.startsWith("/") ? originalUrl : `/${originalUrl}`;
  return `${base.origin}${path}`;
}

/** Turn an incoming Node request into a web `Request`. */
function toWebRequest(
  incoming: IncomingMessage,
  config: McpConfig,
  signal: AbortSignal,
): Request {
  const headers = normalizeHeaders(incoming.headers);
  const clientAddress = clientAddressOf(
    remoteAddressOf(incoming),
    headers,
    config.trustedProxies,
  );
  const webHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    // Drop any client-supplied copy of the header the adapter owns.
    if (name === CLIENT_ADDRESS_HEADER) continue;
    webHeaders.set(name, value);
  }
  if (clientAddress !== undefined)
    webHeaders.set(CLIENT_ADDRESS_HEADER, clientAddress);

  const method = (incoming.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(canonicalUrl(config, incoming.url ?? "/"), {
    method,
    headers: webHeaders,
    ...(hasBody
      ? {
          body: Readable.toWeb(incoming) as unknown as ReadableStream,
          duplex: "half",
        }
      : {}),
    signal,
  } as RequestInit);
}

/** Write a web `Response` to a Node response. */
async function writeResponse(
  outgoing: ServerResponse,
  response: Response,
): Promise<void> {
  outgoing.statusCode = response.status;
  const setCookies: string[] = [];
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") {
      setCookies.push(value);
      return;
    }
    outgoing.setHeader(name, value);
  });
  if (setCookies.length > 0) outgoing.setHeader("set-cookie", setCookies);
  const buffer = Buffer.from(await response.arrayBuffer());
  outgoing.end(buffer);
}

/** A JSON response for the infrastructure endpoints. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Build the MCP service's HTTP listener. */
export function createMcpHttpServer(options: McpHttpServerOptions): Server {
  const { config, observability, handleMcp, ready } = options;

  return createServer((incoming, outgoing) => {
    void (async () => {
      const requestId = `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      const url = incoming.url ?? "/";
      const pathname = url.split("?")[0];
      try {
        // ---- Infrastructure routes -----------------------------------------
        if (pathname === "/health") {
          await writeResponse(outgoing, jsonResponse(200, { status: "ok" }));
          return;
        }
        if (pathname === "/ready") {
          const state = await ready();
          const usable = state.database && state.storage;
          await writeResponse(
            outgoing,
            jsonResponse(usable ? 200 : 503, {
              status: usable ? "ready" : "not_ready",
              checks: {
                database: state.database ? "ok" : "unavailable",
                storage: state.storage ? "ok" : "unavailable",
              },
            }),
          );
          return;
        }
        if (pathname === "/metrics") {
          if (!config.metricsEnabled) {
            await writeResponse(outgoing, new Response(null, { status: 404 }));
            return;
          }
          await writeResponse(
            outgoing,
            new Response(observability.metrics.render(), {
              status: 200,
              headers: { "content-type": "text/plain; version=0.0.4" },
            }),
          );
          return;
        }

        // ---- The MCP endpoint ----------------------------------------------
        if (pathname === config.mcpPath || pathname === `${config.mcpPath}/`) {
          const controller = new AbortController();
          // Abort the in-flight tool when the client goes away, so an expensive
          // validation does not outlive the request that asked for it (§39–40).
          outgoing.on("close", () => {
            if (!outgoing.writableEnded) controller.abort();
          });
          const request = toWebRequest(incoming, config, controller.signal);
          const response = await handleMcp(request);
          await writeResponse(outgoing, response);
          return;
        }

        await writeResponse(
          outgoing,
          jsonResponse(404, {
            error: { code: "not_found", message: "No such route." },
          }),
        );
      } catch (error) {
        options.onError?.(error, requestId);
        if (outgoing.headersSent) {
          outgoing.end();
          return;
        }
        await writeResponse(
          outgoing,
          jsonResponse(500, {
            error: {
              code: "internal_error",
              message: "The request could not be completed.",
              details: { requestId },
            },
          }),
        ).catch(() => outgoing.end());
      }
    })();
  });
}
