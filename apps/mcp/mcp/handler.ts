/**
 * The MCP HTTP request pipeline (Phase 6 §4–9, §34–40, §52–53).
 *
 * One function handles every `/mcp` request, in this order:
 *
 * ```text
 * request
 *   ↓  method gate (POST only; GET 405, DELETE 204)
 *   ↓  content type + body size        (§37)
 *   ↓  Bearer PAT authentication       (§8–10) — before any JSON is trusted
 *   ↓  Mcp-Method / Mcp-Name agreement (§7)  — fail closed on mismatch
 *   ↓  per-credential rate limit       (§34–36)
 *   ↓  official SDK Streamable HTTP transport, stateless (§4–5)
 *   ↓  McpServer for this principal    (§54)
 * ```
 *
 * The transport is the SDK's `WebStandardStreamableHTTPServerTransport` in
 * **stateless JSON mode**: a fresh server and a fresh transport per request, no
 * session id, no server-initiated stream, and a single JSON response body. The
 * Node adapter converts to and from a web `Request`/`Response`, so production
 * and the in-process protocol tests exercise exactly the same code.
 *
 * ## Authentication is not optional and not a cookie
 *
 * There is no anonymous path: a missing or bad credential is a `401` with a
 * challenge, produced before the transport sees the message. A session cookie is
 * never consulted, so a same-site browser `fetch` cannot turn a login into an
 * agent call.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ApplicationContext } from "../../../src/application/context";
import type { ProjectCatalog } from "../../../src/application/project-catalog";
import type { ChangeProposalService } from "../../../src/application/change-proposal-service";
import type { ResourceTrajectoryService } from "../../../src/application/resource-trajectory-service";
import { classForTool, type McpConfig, type RateLimitClass } from "../config";
import type { McpAuthenticator } from "../auth/bearer";
import { bearerChallenge } from "../auth/challenge";
import { hostAllowed } from "../http/proxies";
import type { RateLimiter } from "../rate-limit";
import type { Observability } from "../observability";
import { traceContextOf } from "../observability";
import { checkModernHeaders } from "./headers";
import { createMcpServerForPrincipal } from "./server";

/** Everything the handler needs. */
export interface McpHandlerDeps {
  config: McpConfig;
  catalog: ProjectCatalog;
  proposals: ChangeProposalService;
  trajectory: ResourceTrajectoryService;
  authenticator: McpAuthenticator;
  limiter: RateLimiter;
  observability: Observability;
}

/** The JSON-RPC error codes this layer emits directly. */
const JSONRPC = {
  parseError: -32700,
  invalidRequest: -32600,
} as const;

/** A JSON-RPC error body. */
function jsonRpcError(
  status: number,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    }),
    {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

/** Headers every MCP response carries. */
function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  // The endpoint is authenticated and private; a shared cache must never hold a
  // response that depended on the caller's credential.
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

/** The class a JSON-RPC message belongs to, when headers did not name one. */
function classOfBody(body: unknown): {
  className: RateLimitClass;
  tool: string | null;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { className: "read", tool: null };
  }
  const record = body as Record<string, unknown>;
  const method = typeof record.method === "string" ? record.method : "";
  if (method !== "tools/call") return { className: "read", tool: null };
  const params = record.params;
  const name =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>).name
      : undefined;
  const tool = typeof name === "string" ? name : null;
  return {
    className: tool === null ? "read" : classForTool(tool),
    tool,
  };
}

/** The client key a limiter may use as a secondary dimension. */
function clientKeyOf(
  headers: Readonly<Record<string, string>>,
): string | undefined {
  // `x-sdm-client-address` is set by this service's own HTTP adapter from the
  // socket address (or from a forwarded chain only when the socket is a trusted
  // proxy). The raw `x-forwarded-for` header is never read here, because a
  // client can set it to anything.
  return headers["x-sdm-client-address"];
}

/** Read a lower-cased header record from a web `Request`. */
export function headersOf(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/** Read a request body, refusing one over the limit without buffering it all. */
async function readLimited(
  request: Request,
  limit: number,
): Promise<{ ok: true; body: string } | { ok: false }> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return { ok: false };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > limit) return { ok: false };
  return { ok: true, body: text };
}

/** A refusal to render, or the context a transport call runs under. */
type Pipeline =
  | { kind: "response"; response: Response }
  | {
      kind: "dispatch";
      context: ApplicationContext;
      body: string;
      className: RateLimitClass;
      tool: string | null;
      traceId: string;
    };

/**
 * Run the pre-transport pipeline.
 *
 * Exported so a test can assert the ordering — in particular that authentication
 * happens before the body is parsed and before a tool can run.
 */
export async function runPipeline(
  request: Request,
  deps: McpHandlerDeps,
): Promise<Pipeline> {
  const config = deps.config;
  const headers = headersOf(request);
  const method = request.method.toUpperCase();
  const trace = traceContextOf(headers);

  // ---- Host validation -----------------------------------------------------
  // The canonical MCP URL comes from configuration, never from this header; the
  // check exists so a directly reachable deployment cannot be told it is
  // someone else. An empty allow-list means the deployment is proxy-only.
  if (!hostAllowed(headers.host, config.allowedHosts)) {
    return {
      kind: "response",
      response: secure(
        new Response(
          JSON.stringify({
            error: {
              code: "forbidden",
              message: "This Host is not served by this MCP endpoint.",
            },
          }),
          {
            status: 403,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        ),
      ),
    };
  }

  // ---- Method gate ---------------------------------------------------------
  if (method === "OPTIONS") {
    // No permissive CORS: a browser-originated MCP call is not a supported
    // client, and `Access-Control-Allow-Origin: *` on an authenticated endpoint
    // is a concrete vulnerability, not a convenience (mission §50).
    return {
      kind: "response",
      response: secure(
        new Response("", {
          status: 405,
          headers: { allow: "POST, DELETE" },
        }),
      ),
    };
  }

  if (method === "GET") {
    // A stateless server has no server-initiated stream to open. Authentication
    // still runs first, so an unauthenticated probe learns nothing.
    const auth = await deps.authenticator.authenticate(headers);
    if (auth.state !== "authenticated") {
      return {
        kind: "response",
        response: authRefusal(auth.reason, config),
      };
    }
    return {
      kind: "response",
      response: secure(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: JSONRPC.invalidRequest,
              message: "This MCP endpoint is stateless and POST-only.",
            },
          }),
          {
            status: 405,
            headers: {
              "content-type": "application/json; charset=utf-8",
              allow: "POST, DELETE",
            },
          },
        ),
      ),
    };
  }

  if (method === "DELETE") {
    // Session termination on a stateless server is a successful no-op.
    const auth = await deps.authenticator.authenticate(headers);
    if (auth.state !== "authenticated") {
      return {
        kind: "response",
        response: authRefusal(auth.reason, config),
      };
    }
    return {
      kind: "response",
      response: secure(new Response(null, { status: 204 })),
    };
  }

  if (method !== "POST") {
    return {
      kind: "response",
      response: secure(
        new Response("", { status: 405, headers: { allow: "POST, DELETE" } }),
      ),
    };
  }

  // ---- Authentication, before anything in the body is trusted --------------
  const auth = await deps.authenticator.authenticate(headers);
  if (auth.state !== "authenticated") {
    deps.observability.metrics.increment("auth_failures_total", {
      reason: auth.reason,
    });
    return { kind: "response", response: authRefusal(auth.reason, config) };
  }
  const context: ApplicationContext = {
    requestId: requestIdOf(headers),
    principal: auth.principal,
  };

  // ---- Content type and size ----------------------------------------------
  const contentType = headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return {
      kind: "response",
      response: jsonRpcError(
        415,
        JSONRPC.invalidRequest,
        "The request body must be application/json.",
      ),
    };
  }
  const read = await readLimited(request, config.maxBodyBytes);
  if (!read.ok) {
    return {
      kind: "response",
      response: secure(
        jsonRpcError(
          413,
          JSONRPC.invalidRequest,
          `The MCP message exceeds the ${config.maxBodyBytes} byte limit.`,
        ),
      ),
    };
  }
  const body = read.body;
  if (body.trim() === "") {
    return {
      kind: "response",
      response: jsonRpcError(
        400,
        JSONRPC.parseError,
        "The request body is empty.",
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      kind: "response",
      response: jsonRpcError(
        400,
        JSONRPC.parseError,
        "The request body is not valid JSON.",
      ),
    };
  }

  // ---- Mcp-Method / Mcp-Name agreement ------------------------------------
  const headerCheck = checkModernHeaders(headers, parsed);
  if (!headerCheck.ok) {
    return {
      kind: "response",
      response: jsonRpcError(
        headerCheck.status,
        headerCheck.code,
        headerCheck.message,
        headerCheck.data,
      ),
    };
  }

  // ---- Rate limit ----------------------------------------------------------
  const classification = classOfBody(parsed);
  const className = classification.className;
  const credentialId = credentialIdOf(context);
  const decision = deps.limiter.check({
    credentialId,
    className,
    ...(clientKeyOf(headers) === undefined
      ? {}
      : { clientKey: clientKeyOf(headers) }),
  });
  if (!decision.allowed) {
    deps.observability.metrics.increment("rate_limit_rejections_total", {
      class: className,
    });
    deps.observability.logger.log({
      event: "mcp.rate_limited",
      level: "warn",
      requestId: context.requestId,
      traceId: trace.traceId,
      credentialId,
      subjectUserId: context.principal.subjectUserId,
      method: headerCheck.method ?? undefined,
      result: "rate_limited",
    });
    return {
      kind: "response",
      response: secure(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: JSONRPC.invalidRequest,
              message: `Rate limit exceeded for ${className} operations. Retry in ${decision.retryAfterSeconds}s.`,
              data: {
                class: className,
                limit: decision.limit,
                retryAfterSeconds: decision.retryAfterSeconds,
              },
            },
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "retry-after": String(decision.retryAfterSeconds),
            },
          },
        ),
      ),
    };
  }

  deps.observability.metrics.increment("mcp_tool_calls_total", {
    tool: classification.tool ?? headerCheck.method ?? method,
  });

  return {
    kind: "dispatch",
    context,
    body,
    className,
    tool: classification.tool,
    traceId: trace.traceId,
  };
}

/** Build the `401` a refused credential receives, with a challenge. */
function authRefusal(
  reason: "missing" | "invalid",
  config: McpConfig,
): Response {
  return secure(
    new Response(
      JSON.stringify({
        error: {
          code: "unauthorized",
          message:
            reason === "missing"
              ? "A personal access token is required."
              : "The personal access token is invalid or has expired.",
        },
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "www-authenticate": bearerChallenge({ publicUrl: config.publicUrl }),
        },
      },
    ),
  );
}

/** The correlation id for a request, from `x-request-id` or generated. */
function requestIdOf(headers: Readonly<Record<string, string>>): string {
  const supplied = headers["x-request-id"];
  if (supplied !== undefined && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) {
    return supplied;
  }
  return `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** The credential an application context authenticated with. */
function credentialIdOf(context: ApplicationContext): string {
  return context.principal.actor.kind === "agent"
    ? context.principal.actor.credentialId
    : context.principal.subjectUserId;
}

/**
 * Handle one `/mcp` request end to end.
 *
 * The transport is created, connected and closed per request: that is what
 * stateless means here, and it is why no request can observe another request's
 * protocol state.
 */
export async function handleMcpRequest(
  request: Request,
  deps: McpHandlerDeps,
): Promise<Response> {
  const started = Date.now();
  const pipeline = await runPipeline(request, deps);
  if (pipeline.kind === "response") return pipeline.response;

  const { context, body, className, tool, traceId } = pipeline;
  const { server } = createMcpServerForPrincipal({
    context,
    catalog: deps.catalog,
    proposals: deps.proposals,
    trajectory: deps.trajectory,
    config: deps.config,
    observability: deps.observability,
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id is minted, so nothing has to be remembered.
    sessionIdGenerator: undefined,
    // A single JSON body keeps the endpoint cache-friendly and free of a
    // long-lived stream the deployment would have to scale.
    enableJsonResponse: true,
  });

  let response: Response;
  try {
    await server.connect(transport);
    // Rebuild the request so the transport reads the body we already validated
    // and measured, and so the URL is the configured one rather than the Host
    // header the client chose.
    const forwards = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body,
      signal: request.signal,
    });
    response = await transport.handleRequest(forwards);
  } catch (error) {
    deps.observability.logger.log({
      event: "mcp.request.failed",
      level: "error",
      requestId: context.requestId,
      traceId,
      result: "internal",
      message: error instanceof Error ? error.message : String(error),
    });
    return secure(
      jsonRpcError(
        500,
        -32603,
        `The request could not be completed. Reference: ${context.requestId}.`,
      ),
    );
  } finally {
    // A per-request transport and server own no resources worth keeping; closing
    // both is what stops keep-alive timers and stream maps from accumulating.
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }

  deps.observability.metrics.increment("mcp_requests_total", {
    method: request.method,
    class: className,
    outcome: response.status < 400 ? "success" : "failure",
  });
  deps.observability.logger.log({
    event: "mcp.request",
    requestId: context.requestId,
    traceId,
    method: request.method,
    tool: tool ?? undefined,
    durationMs: Date.now() - started,
    actorType: context.principal.actor.kind,
    credentialId: credentialIdOf(context),
    subjectUserId: context.principal.subjectUserId,
    result: response.status < 400 ? "success" : `http_${response.status}`,
  });

  return secure(response);
}

/** Whether a request targets the configured MCP path. */
export function isMcpPath(pathname: string, config: McpConfig): boolean {
  return pathname === config.mcpPath || pathname === `${config.mcpPath}/`;
}
