/**
 * The remote MCP server: JSON-RPC dispatch over the shared protocol (Phase 5).
 *
 * This is the remote counterpart of `mcp/server.ts`. It speaks the same wire
 * format — the vocabulary lives in `src/shared/mcp/protocol.ts` so both hosts
 * use one definition — but its tools come from {@link createRemoteTools}, which
 * call the shared project catalog rather than a filesystem workspace.
 *
 * ## What it does not do
 *
 * - It does not authenticate. The HTTP transport verifies the bearer PAT and
 *   hands the resulting {@link ApplicationContext} in, so the dispatcher only
 *   ever sees an already-identified principal.
 * - It does not authorize *project* access. Each tool's use case does that.
 *   The one check here is the credential's `mcp:read`/`mcp:write` capability,
 *   which decides which tools are even visible and is re-checked at call time.
 *
 * ## Scope visibility
 *
 * A read-only token's `tools/list` omits the write tools rather than offering
 * them and failing. A client that calls one anyway is still refused, so the
 * listing is a courtesy and the call-time check is the boundary.
 */
import packageJson from "../../../package.json";
import type { ApplicationContext } from "../../../src/application/context";
import type { ProjectCatalog } from "../../../src/application/project-catalog";
import { credentialGrants } from "../../../src/application/authorization";
import { forbidden } from "../../../src/application/errors";
import {
  DEFAULT_LEGACY_PROTOCOL_VERSION,
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  META_SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  errorResponse,
  isJsonRpcRequest,
  modernProtocolVersionOf,
  successResponse,
  unsupportedProtocolVersion,
  type JsonRpcId,
  type JsonRpcResponse,
  type ToolDefinition,
} from "../../../src/shared/mcp/protocol";
import { describeMcpError, toMcpError } from "./errors";
import { createRemoteTools, findRemoteTool, type RemoteTool } from "./tools";

/** The remote server's advertised name. */
export const REMOTE_SERVER_NAME = "sequencediagrams-remote";
/** The remote server's advertised version, from the package it ships in. */
export const REMOTE_SERVER_VERSION = packageJson.version;

/**
 * The guidance returned by `initialize` and `server/discover`.
 *
 * Written for a machine caller: it names the bearer scheme, insists on reading
 * before writing, and explains the revision contract in the terms a tool result
 * uses.
 */
export const REMOTE_INSTRUCTIONS = `This server exposes the projects of a SequenceDiagrams account to an external agent, authenticated with a personal access token presented as \`Authorization: Bearer sdm_pat_…\`.

Work in this order:
1. list_projects — the project ids every other tool addresses.
2. list_resources or get_project — see what exists and what your token may do.
3. read_resource — get a document's text *and its current revision*.
4. update_resource / move_resource — send the revision you just read as expectedRevision. If the write returns a conflict, someone wrote first: read again and retry at the new revision. Never invent a revision.
5. create_resource — a new path only; update_resource changes an existing document.

A token carries a scope. "projects:read" can only read; "projects:write" can also create, update, move and delete. Project membership still applies: the token can never act outside the projects its owner belongs to.`;

/** Options for {@link createRemoteMcpServer}. */
export interface RemoteMcpServerOptions {
  context: ApplicationContext;
  catalog: ProjectCatalog;
}

/** A handleable remote MCP server, independent of the HTTP transport. */
export interface RemoteMcpServer {
  /** The guidance returned by `initialize` and `server/discover`. */
  readonly instructions: string;
  /** The tools visible to this principal, in catalog order. */
  readonly tools: ToolDefinition[];
  /** Dispatch one decoded JSON-RPC message; `null` for a notification. */
  handle(message: unknown): Promise<JsonRpcResponse | null>;
}

/** The capabilities this server declares. */
const CAPABILITIES = {
  tools: { listChanged: false },
} as const;

/** A short freshness hint for cacheable list results. */
const TTL_MS = 5_000;

/** The identity block modern results carry in `_meta`. */
function serverInfo(): { name: string; version: string; title: string } {
  return {
    name: REMOTE_SERVER_NAME,
    version: REMOTE_SERVER_VERSION,
    title: "SequenceDiagrams server projects",
  };
}

/** Whether this credential may call a tool at all. */
function canCall(context: ApplicationContext, tool: RemoteTool): boolean {
  return credentialGrants(context.principal, tool.requiredPermission);
}

/**
 * Build the remote server for one authenticated request.
 *
 * The server is per-request by construction: it captures the principal, so one
 * caller's tools can never run with another caller's identity, and there is no
 * session state to leak between requests.
 */
export function createRemoteMcpServer(
  options: RemoteMcpServerOptions,
): RemoteMcpServer {
  const { context, catalog } = options;
  const allTools = createRemoteTools();
  const visible = allTools.filter((tool) => canCall(context, tool));

  /** Add the modern `resultType` marker to an ordinary result. */
  function complete(result: Record<string, unknown>): Record<string, unknown> {
    return { resultType: "complete", ...result };
  }

  /** Add the modern cache fields to a list result. */
  function cacheable(result: Record<string, unknown>): Record<string, unknown> {
    return { ...result, ttlMs: TTL_MS, cacheScope: "private" };
  }

  /** Attach the server's identity to a result for a modern request. */
  function stamp(
    result: Record<string, unknown>,
    modern: boolean,
  ): Record<string, unknown> {
    if (!modern) return result;
    return { ...result, _meta: { [META_SERVER_INFO]: serverInfo() } };
  }

  /** Wrap a tool outcome as an MCP tool result. */
  function toolSuccess(outcome: {
    text: string;
    structured?: unknown;
  }): Record<string, unknown> {
    const result: Record<string, unknown> = {
      resultType: "complete",
      content: [{ type: "text", text: outcome.text }],
      isError: false,
    };
    if (outcome.structured !== undefined) {
      result.structuredContent = outcome.structured;
    }
    return result;
  }

  /** Wrap a failure as a structured tool error the model can act on. */
  function toolFailure(error: unknown): Record<string, unknown> {
    const mapped = toMcpError(error, context.requestId);
    return {
      resultType: "complete",
      content: [{ type: "text", text: describeMcpError(mapped) }],
      structuredContent: { error: mapped },
      isError: true,
    };
  }

  return {
    instructions: REMOTE_INSTRUCTIONS,
    tools: visible.map((tool) => tool.definition),

    async handle(message: unknown): Promise<JsonRpcResponse | null> {
      if (
        typeof message !== "object" ||
        message === null ||
        (message as Record<string, unknown>).jsonrpc !== "2.0"
      ) {
        return errorResponse(
          null,
          ErrorCode.InvalidRequest,
          "Invalid JSON-RPC 2.0 message",
        );
      }
      const record = message as Record<string, unknown>;
      if (!isJsonRpcRequest(record)) return null;

      const id = record.id as JsonRpcId;
      const method = record.method;
      const params = record.params;
      const modernVersion = modernProtocolVersionOf(params);
      const modern = modernVersion !== null;

      if (
        modernVersion !== null &&
        !SUPPORTED_PROTOCOL_VERSIONS.includes(modernVersion)
      ) {
        return unsupportedProtocolVersion(id, modernVersion);
      }

      try {
        switch (method) {
          case "initialize": {
            const requested =
              typeof params === "object" && params !== null
                ? (params as Record<string, unknown>).protocolVersion
                : undefined;
            const negotiated =
              typeof requested === "string" &&
              SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
                ? requested
                : DEFAULT_LEGACY_PROTOCOL_VERSION;
            return successResponse(id, {
              protocolVersion: negotiated,
              capabilities: CAPABILITIES,
              serverInfo: serverInfo(),
              instructions: REMOTE_INSTRUCTIONS,
            });
          }

          case "server/discover":
            return successResponse(
              id,
              cacheable(
                stamp(
                  {
                    resultType: "complete",
                    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
                    capabilities: CAPABILITIES,
                    instructions: REMOTE_INSTRUCTIONS,
                  },
                  true,
                ),
              ),
            );

          case "ping":
            return successResponse(id, {});

          case "tools/list":
            return successResponse(
              id,
              cacheable(
                stamp(
                  complete({ tools: visible.map((t) => t.definition) }),
                  modern,
                ),
              ),
            );

          case "tools/call": {
            if (typeof params !== "object" || params === null) {
              return errorResponse(
                id,
                ErrorCode.InvalidParams,
                "tools/call requires params with a tool name",
              );
            }
            const call = params as Record<string, unknown>;
            const name = call.name;
            if (typeof name !== "string" || name === "") {
              return errorResponse(
                id,
                ErrorCode.InvalidParams,
                "tools/call requires a non-empty tool name",
              );
            }
            const tool = findRemoteTool(allTools, name);
            if (!tool) {
              return errorResponse(
                id,
                ErrorCode.InvalidParams,
                `Unknown tool: ${name}`,
                {
                  available: allTools.map((entry) => entry.definition.name),
                },
              );
            }
            const args =
              typeof call.arguments === "object" && call.arguments !== null
                ? (call.arguments as Record<string, unknown>)
                : {};
            try {
              // The visibility filter is a courtesy; this is the boundary.
              if (!canCall(context, tool)) {
                throw forbidden(
                  `This credential does not carry the ${tool.requiredPermission} permission required by ${name}.`,
                );
              }
              const outcome = await tool.run(args, { context, catalog });
              return successResponse(id, stamp(toolSuccess(outcome), modern));
            } catch (error) {
              return successResponse(id, stamp(toolFailure(error), modern));
            }
          }

          default:
            return errorResponse(
              id,
              ErrorCode.MethodNotFound,
              `Unknown method: ${String(method)}`,
            );
        }
      } catch (error) {
        // An unexpected throw in dispatch itself. The detail is not echoed to
        // the client; the correlation id is what ties it to the server log.
        return successResponse(id, stamp(toolFailure(error), modern));
      }
    },
  };
}

/** The newest protocol revision, re-exported for the transport's headers. */
export { LATEST_PROTOCOL_VERSION };
