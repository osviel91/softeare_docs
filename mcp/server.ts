/**
 * The MCP server: message dispatch, the two protocol eras, and the stdio loop.
 *
 * The server is deliberately thin. It decodes a message, routes it to a handler
 * built from modules that are themselves testable without a transport
 * ({@link DocumentationWorkspace}, the tool catalog, the reference and prompt
 * sets), and encodes the result. Nothing in this file knows what a diagram is.
 *
 * ## Two eras, one process
 *
 * The MCP specification changed shape in `2026-07-28`: sessions and the
 * `initialize` handshake were removed, every request carries its version in
 * `_meta`, every result carries `resultType`, and a server must answer
 * `server/discover`. Deployed clients are a mix — a legacy client only knows
 * `initialize`, a modern one probes with `server/discover` — so this server is
 * *dual-era*: it answers `initialize` for legacy clients, honours per-request
 * `_meta` and `server/discover` for modern ones, and includes the modern
 * `resultType`/`ttlMs`/`cacheScope` fields harmlessly for both.
 *
 * See https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
 *
 * ## stdio
 *
 * Messages are newline-delimited JSON on stdin/stdout, and stdout carries
 * nothing but MCP messages (diagnostics go to stderr). The process exits
 * promptly when stdin closes, which the specification names as the primary
 * graceful-shutdown signal.
 */
import packageJson from "../package.json";
import {
  DEFAULT_LEGACY_PROTOCOL_VERSION,
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  META_SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  decodeChunk,
  encodeMessage,
  errorResponse,
  isJsonRpcRequest,
  modernProtocolVersionOf,
  successResponse,
  unsupportedProtocolVersion,
  type JsonRpcId,
  type JsonRpcResponse,
  type PromptDefinition,
  type ResourceDefinition,
  type ResourceTemplateDefinition,
  type ToolDefinition,
} from "./protocol";
import {
  PROJECT_RESOURCE_TEMPLATE,
  SERVER_INSTRUCTIONS,
  parseProjectResourceUri,
  resourceTemplates,
  staticResourceText,
  staticResources,
} from "./reference";
import { promptDefinitions, resolvePrompt } from "./prompts";
import { createTools, findTool } from "./tools";
import { DocumentationWorkspace } from "./workspace";

/** The server's advertised name. */
export const SERVER_NAME = "sequencediagrams";
/** The server's advertised version, taken from the package it ships in. */
export const SERVER_VERSION = packageJson.version;

/** Options for {@link createMcpServer}. */
export interface McpServerOptions {
  /** The workspace directory the server operates on. */
  workspaceRoot: string;
  /** A project id/name used when a tool omits `project`. */
  defaultProject?: string;
}

/** A handleable MCP server, independent of any transport. */
export interface McpServer {
  /** The guidance returned by `initialize` and `server/discover`. */
  readonly instructions: string;
  /** The tools this server exposes. */
  readonly tools: ToolDefinition[];
  /** Dispatch one decoded JSON-RPC message; `null` for a notification. */
  handle(message: unknown): Promise<JsonRpcResponse | null>;
}

/** The capabilities this server declares. */
const CAPABILITIES = {
  tools: { listChanged: false },
  resources: { listChanged: false },
  prompts: { listChanged: false },
} as const;

/** A short freshness hint for cacheable list/read results. */
const TTL_MS = 5_000;

/** The identity block modern results carry in `_meta`. */
function serverInfo(): { name: string; version: string; title: string } {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    title: "SequenceDiagrams documentation",
  };
}

/**
 * Build a server over one workspace.
 *
 * Everything the handlers need is constructed once: the tool catalog is static,
 * and the workspace holds only the repository root and the default project, so
 * two tool calls cannot interfere through shared state.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const workspace = DocumentationWorkspace.open(
    options.workspaceRoot,
    options.defaultProject,
  );
  const tools = createTools();
  const resources: ResourceDefinition[] = staticResources();
  const templates: ResourceTemplateDefinition[] = resourceTemplates();
  const prompts: PromptDefinition[] = promptDefinitions();

  /** Add the modern `resultType` marker to an ordinary result. */
  function complete(result: Record<string, unknown>): Record<string, unknown> {
    return { resultType: "complete", ...result };
  }

  /** Add the modern cache fields to a list/read result. */
  function cacheable(result: Record<string, unknown>): Record<string, unknown> {
    return { ...result, ttlMs: TTL_MS, cacheScope: "public" };
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

  /** Wrap a thrown error as a tool-execution error the model can act on. */
  function toolFailure(error: unknown): Record<string, unknown> {
    const message = error instanceof Error ? error.message : String(error);
    return {
      resultType: "complete",
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }

  return {
    instructions: SERVER_INSTRUCTIONS,
    tools: tools.map((tool) => tool.definition),

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

      // A notification has no id and expects no response; the ones that matter
      // to a stateful legacy client are acknowledgement-only.
      if (!isJsonRpcRequest(record)) {
        return null;
      }

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
            // Legacy handshake. A dual-era server answers it so a client that
            // only knows this revision works; the version echoed back is the
            // client's when this server implements it.
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
              instructions: SERVER_INSTRUCTIONS,
            });
          }

          case "server/discover": {
            // Modern discovery: the probe a dual-era client uses to learn the
            // server's era and versions.
            return successResponse(
              id,
              cacheable(
                stamp(
                  {
                    resultType: "complete",
                    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
                    capabilities: CAPABILITIES,
                    instructions: SERVER_INSTRUCTIONS,
                  },
                  true,
                ),
              ),
            );
          }

          case "ping":
            // Removed in the modern revision but harmless to answer, and some
            // legacy clients use it as a liveness check.
            return successResponse(id, {});

          case "tools/list":
            return successResponse(
              id,
              cacheable(
                stamp(
                  complete({ tools: tools.map((tool) => tool.definition) }),
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
            const tool = findTool(tools, name);
            if (!tool) {
              return errorResponse(
                id,
                ErrorCode.InvalidParams,
                `Unknown tool: ${name}`,
                { available: tools.map((entry) => entry.definition.name) },
              );
            }
            const args =
              typeof call.arguments === "object" && call.arguments !== null
                ? (call.arguments as Record<string, unknown>)
                : {};
            try {
              const outcome = await tool.run(args, { workspace });
              return successResponse(id, stamp(toolSuccess(outcome), modern));
            } catch (error) {
              // A tool failure is data, not a protocol error: the model is
              // meant to read the message and retry with better arguments.
              return successResponse(id, stamp(toolFailure(error), modern));
            }
          }

          case "resources/list":
            return successResponse(
              id,
              cacheable(stamp(complete({ resources }), modern)),
            );

          case "resources/templates/list":
            return successResponse(
              id,
              cacheable(
                stamp(complete({ resourceTemplates: templates }), modern),
              ),
            );

          case "resources/read": {
            if (typeof params !== "object" || params === null) {
              return errorResponse(
                id,
                ErrorCode.InvalidParams,
                "resources/read requires a uri",
              );
            }
            const uri = (params as Record<string, unknown>).uri;
            if (typeof uri !== "string" || uri === "") {
              return errorResponse(
                id,
                ErrorCode.InvalidParams,
                "resources/read requires a non-empty uri",
              );
            }
            const staticText = staticResourceText(uri);
            if (staticText !== null) {
              const definition = resources.find((entry) => entry.uri === uri);
              return successResponse(
                id,
                cacheable(
                  stamp(
                    complete({
                      contents: [
                        {
                          uri,
                          mimeType: definition?.mimeType ?? "text/markdown",
                          text: staticText,
                        },
                      ],
                    }),
                    modern,
                  ),
                ),
              );
            }
            const parsed = parseProjectResourceUri(uri);
            if (parsed) {
              try {
                const project = await workspace.resolveProject(parsed.project);
                const { content } = await workspace.readResource(
                  project,
                  parsed.path,
                );
                return successResponse(
                  id,
                  cacheable(
                    stamp(
                      complete({
                        contents: [
                          { uri, mimeType: "text/plain", text: content },
                        ],
                      }),
                      modern,
                    ),
                  ),
                );
              } catch (error) {
                return errorResponse(
                  id,
                  ErrorCode.InvalidParams,
                  `Resource not found: ${uri}`,
                  {
                    detail:
                      error instanceof Error ? error.message : String(error),
                  },
                );
              }
            }
            return errorResponse(
              id,
              ErrorCode.InvalidParams,
              `Resource not found: ${uri}`,
              {
                available: [
                  ...resources.map((entry) => entry.uri),
                  PROJECT_RESOURCE_TEMPLATE,
                ],
              },
            );
          }

          case "prompts/list":
            return successResponse(
              id,
              cacheable(stamp(complete({ prompts }), modern)),
            );

          case "prompts/get": {
            if (typeof params !== "object" || params === null) {
              return errorResponse(
                id,
                ErrorCode.InvalidParams,
                "prompts/get requires a prompt name",
              );
            }
            const get = params as Record<string, unknown>;
            const name = get.name;
            if (typeof name !== "string" || name === "") {
              return errorResponse(
                id,
                ErrorCode.InvalidParams,
                "prompts/get requires a non-empty prompt name",
              );
            }
            const promptArgs =
              typeof get.arguments === "object" && get.arguments !== null
                ? (get.arguments as Record<string, string>)
                : undefined;
            const resolved = resolvePrompt(name, promptArgs);
            if (!resolved) {
              return errorResponse(
                id,
                ErrorCode.InvalidParams,
                `Unknown prompt or missing required argument: ${name}`,
                { available: prompts.map((entry) => entry.name) },
              );
            }
            return successResponse(
              id,
              stamp(
                complete({
                  description: resolved.description,
                  messages: resolved.messages,
                }),
                modern,
              ),
            );
          }

          default:
            return errorResponse(
              id,
              ErrorCode.MethodNotFound,
              `Unknown method: ${String(method)}`,
            );
        }
      } catch (error) {
        return errorResponse(
          id,
          ErrorCode.InternalError,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

/**
 * Run the server over stdio until stdin closes.
 *
 * Resolves when the client closes the input stream, which is the portable
 * shutdown signal the specification asks a server to honour.
 */
export async function runStdioServer(options: McpServerOptions): Promise<void> {
  const server = createMcpServer(options);
  process.stdin.setEncoding("utf8");

  let buffer = "";
  const write = (response: JsonRpcResponse): void => {
    process.stdout.write(encodeMessage(response));
  };

  const dispatch = async (line: string): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      write(errorResponse(null, ErrorCode.ParseError, "Parse error"));
      return;
    }
    const response = await server.handle(parsed);
    if (response) write(response);
  };

  for await (const chunk of process.stdin) {
    const { messages, rest } = decodeChunk(buffer, String(chunk));
    buffer = rest;
    for (const message of messages) {
      await dispatch(message);
    }
  }
  if (buffer.trim() !== "") {
    await dispatch(buffer.trim());
  }
}

/** The newest protocol revision, re-exported for the CLI's `--version` output. */
export { LATEST_PROTOCOL_VERSION };
