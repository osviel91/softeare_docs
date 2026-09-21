/**
 * Wire types for the Model Context Protocol, plus the small amount of
 * JSON-RPC plumbing the server needs.
 *
 * The protocol is implemented here rather than pulled in as a dependency, for
 * the same reason the ZIP codec and the markdown renderer are: it is a small,
 * stable, fully specified wire format, and owning it keeps the server's
 * dependency surface at zero and its behaviour testable as plain functions.
 *
 * Two protocol eras are covered. The **modern** revision (`2026-07-28`) is
 * stateless: every request carries its version and client capabilities in
 * `_meta`, every result carries `resultType`, and a server MUST answer
 * `server/discover`. The **legacy** revisions (`2025-11-25` and earlier) open
 * with an `initialize` handshake and then address the same methods. Real MCP
 * clients — OpenCode, Hermes, Claude, Cursor — are still a mix of the two, so
 * this server is *dual-era*: it answers `initialize` for legacy clients and
 * per-request `_meta` plus `server/discover` for modern ones.
 *
 * See https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
 */

/** The newest protocol revision this server implements. */
export const LATEST_PROTOCOL_VERSION = "2026-07-28";

/**
 * The revision reported to a legacy client whose requested version is unknown.
 *
 * Chosen over the newest revision on purpose: a legacy client has no
 * fall-forward mechanism, and this is the most recent revision that still opens
 * with the `initialize` handshake it knows how to speak.
 */
export const DEFAULT_LEGACY_PROTOCOL_VERSION = "2025-06-18";

/** Every protocol revision the server can serve, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  LATEST_PROTOCOL_VERSION,
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

/** The `_meta` key a modern request carries its protocol version in. */
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
/** The `_meta` key a modern request carries its client identity in. */
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
/** The `_meta` key a modern request carries its client capabilities in. */
export const META_CLIENT_CAPABILITIES =
  "io.modelcontextprotocol/clientCapabilities";
/** The `_meta` key a modern result identifies the server in. */
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** Standard JSON-RPC error codes, plus the MCP-specific ones we can return. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** The request declared a protocol version this server does not implement. */
  UnsupportedProtocolVersion: -32022,
} as const;

/** A JSON-RPC message id: a string, a number, or `null` for a parse failure. */
export type JsonRpcId = string | number | null;

/** A JSON-RPC request: a message with an id that expects a response. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

/** A JSON-RPC notification: a message with no id that expects no response. */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** A JSON-RPC error object. */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** A JSON-RPC response to a {@link JsonRpcRequest}. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

/** Text content, the only content type these tools return. */
export interface TextContent {
  type: "text";
  text: string;
}

/** A link to one of the server's own MCP resources. */
export interface ResourceLinkContent {
  type: "resource_link";
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** Any content block a tool result may carry. */
export type ContentBlock = TextContent | ResourceLinkContent;

/**
 * The result of a `tools/call`.
 *
 * `structuredContent` is the machine-readable form; `content` repeats it as
 * text because the specification asks a tool that returns structured content to
 * also return the serialized JSON in a text block, for clients that predate
 * structured output.
 */
export interface ToolResult {
  resultType?: "complete";
  content: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** One `resources/list` entry. */
export interface ResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** One `resources/templates/list` entry. */
export interface ResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** One `prompts/list` entry. */
export interface PromptDefinition {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** One message of a `prompts/get` result. */
export interface PromptMessage {
  role: "user" | "assistant";
  content: TextContent;
}

/** A JSON Schema object, as accepted by `inputSchema`/`outputSchema`. */
export type JsonSchema = Record<string, unknown>;

/**
 * A tool's JSON Schema `annotations`, which clients use for trust decisions.
 *
 * A client that marks this server untrusted (Hermes' `trust: untrusted`, for
 * example) requires approval for every call whose tool is not annotated
 * `readOnlyHint: true`, so the hints below are a real security boundary and not
 * decoration.
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** One `tools/list` entry. */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
}

/** Extract the `_meta` bag from a params object, if it has one. */
export function metaOf(params: unknown): Record<string, unknown> | null {
  if (typeof params !== "object" || params === null) return null;
  const meta = (params as Record<string, unknown>)._meta;
  if (typeof meta !== "object" || meta === null) return null;
  return meta as Record<string, unknown>;
}

/**
 * The protocol version a request declares through modern per-request metadata,
 * or `null` when the request is legacy (or omits the metadata).
 */
export function modernProtocolVersionOf(params: unknown): string | null {
  const value = metaOf(params)?.[META_PROTOCOL_VERSION];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Whether an unknown value is a JSON-RPC request (has an id) or notification. */
export function isJsonRpcRequest(
  message: Record<string, unknown>,
): message is Record<string, unknown> & JsonRpcRequest {
  return typeof message.method === "string" && "id" in message;
}

/** Build a successful JSON-RPC response. */
export function successResponse(
  id: JsonRpcId,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/** Build a JSON-RPC error response. */
export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcErrorObject = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/** The `UnsupportedProtocolVersionError` the specification mandates. */
export function unsupportedProtocolVersion(
  id: JsonRpcId,
  requested: string,
): JsonRpcResponse {
  return errorResponse(
    id,
    ErrorCode.UnsupportedProtocolVersion,
    "Unsupported protocol version",
    { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested },
  );
}

/**
 * Serialize one message as a stdio frame.
 *
 * The stdio transport delimits messages by newline and forbids embedded
 * newlines, so any newline a message happens to contain is escaped by
 * `JSON.stringify` (which never emits a raw newline inside a string).
 */
export function encodeMessage(message: JsonRpcResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Split a stream chunk into complete frames, keeping the trailing partial line.
 *
 * stdin delivers arbitrary chunks, so a naive `split("\n")` per chunk would
 * corrupt a message that straddles a chunk boundary. The caller threads the
 * returned `rest` through to the next chunk.
 */
export function decodeChunk(
  buffer: string,
  chunk: string,
): { messages: string[]; rest: string } {
  const combined = buffer + chunk;
  const lines = combined.split("\n");
  const rest = lines.pop() ?? "";
  return {
    messages: lines.map((line) => line.trim()).filter((line) => line !== ""),
    rest,
  };
}
