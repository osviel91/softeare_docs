/**
 * The remote MCP endpoint (Phase 5, mission item 5).
 *
 * One route — `POST /mcp` — carrying the Model Context Protocol over the
 * *Streamable HTTP* transport, in its simplest conformant form: a JSON-RPC
 * request in, a JSON-RPC result out, `application/json` on the wire. The
 * server is stateless, so there is no session id to negotiate and no
 * server-initiated stream to open; a client that expects one gets a clean
 * `405` for `GET` and a `204` for `DELETE`, which is what a stateless server
 * should say.
 *
 * ## Authentication is the transport's job, and only a PAT counts
 *
 * {@link requireBearerContext} is called before a single byte of the message is
 * decoded. It accepts `Authorization: Bearer sdm_pat_…` and nothing else — no
 * session cookie, no query parameter — so a same-site browser `fetch` cannot
 * turn a cookie into an agent call, and an unauthenticated request is refused
 * with a `401` and `WWW-Authenticate` rather than a tool error.
 *
 * ## Why the cross-site check does not break machine clients
 *
 * The transport's Fetch Metadata / `Origin` check only constrains requests that
 * carry browser metadata. A server-to-server MCP client sends neither header,
 * and a browser cross-site `fetch` cannot set `Authorization` without a
 * preflight, so the existing CSRF posture is unchanged.
 *
 * ## Errors
 *
 * - malformed JSON → `400` with a JSON-RPC parse error (never a stack trace);
 * - a tool failure → a normal `tools/call` *result* with `isError: true` and a
 *   structured `error.code`, because the model is meant to read it and retry;
 * - an authentication failure → the API's normal `401` JSON envelope.
 */
import type { Router } from "../http/router";
import { errorResponse, json, type ServerResponse } from "../http/http";
import { guarded } from "../http/errors";
import { correlationId } from "../http/node-server";
import { requireBearerContext } from "../auth/pat";
import {
  ErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcResponse,
} from "../../../src/shared/mcp/protocol";
import { createRemoteMcpServer } from "./server";
import type { AppDependencies } from "../app";

/** The one body size an MCP message may have. */
const MAX_MCP_BODY_BYTES = 1024 * 1024;

/** Register the remote MCP transport on a router. */
export function registerRemoteMcpRoutes(
  router: Router,
  dependencies: AppDependencies,
): void {
  /**
   * The server-initiated stream a stateful MCP server would open here.
   *
   * This server is stateless: every request carries its own authentication and
   * its own protocol version, so there is nothing to stream. Answering `405`
   * with `Allow: POST` is the honest answer, and it is what the specification
   * tells a client to expect from a server that does not offer one.
   */
  router.get("/mcp", async () =>
    errorResponse(
      405,
      "method_not_allowed",
      "This MCP endpoint is POST-only.",
      undefined,
      [{ name: "allow", value: "POST, DELETE" }],
    ),
  );

  // Session termination. There is no session to end, so this is a successful
  // no-op rather than a lie about having torn something down.
  router.delete("/mcp", async () => json(204, null));

  router.post("/mcp", async (request) =>
    guarded(correlationId(request), async () => {
      // Identity first: no token, no parsing, no tool list.
      const context = await requireBearerContext(dependencies.tokens, request);

      const versionError = protocolVersionRefusal(request.headers);
      if (versionError !== null) return versionError;

      const raw = request.body ?? "";
      if (raw.length > MAX_MCP_BODY_BYTES) {
        return errorResponse(
          413,
          "payload_too_large",
          `The MCP message exceeds the ${MAX_MCP_BODY_BYTES} byte limit.`,
        );
      }
      if (raw.trim() === "") {
        return parseError("The request body is empty.");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return parseError("The request body is not valid JSON.");
      }

      const server = createRemoteMcpServer({
        context,
        catalog: dependencies.catalog,
      });

      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          return parseError(
            "A JSON-RPC batch must contain at least one message.",
          );
        }
        const responses: JsonRpcResponse[] = [];
        for (const message of parsed) {
          const response = await server.handle(message);
          if (response !== null) responses.push(response);
        }
        return responses.length === 0 ? accepted() : json(200, responses);
      }

      const response = await server.handle(parsed);
      // A notification expects no answer; `202` acknowledges it without
      // inventing a result the client never asked for.
      if (response === null) return accepted();
      return json(200, response);
    }),
  );
}

/** Validate the `MCP-Protocol-Version` header a client may send. */
function protocolVersionRefusal(
  headers: Readonly<Record<string, string>>,
): ServerResponse | null {
  const requested = headers["mcp-protocol-version"];
  if (requested === undefined || requested.trim() === "") return null;
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requested.trim())) return null;
  return json(400, {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: ErrorCode.UnsupportedProtocolVersion,
      message: "Unsupported protocol version",
      data: {
        supported: [...SUPPORTED_PROTOCOL_VERSIONS],
        requested: requested.trim(),
      },
    },
  });
}

/** A JSON-RPC parse error, as the specification asks for on bad input. */
function parseError(message: string): ServerResponse {
  return json(400, {
    jsonrpc: "2.0",
    id: null,
    error: { code: ErrorCode.ParseError, message },
  });
}

/** The empty acknowledgement a notification receives. */
function accepted(): ServerResponse {
  return { status: 202, headers: [], body: "" };
}
