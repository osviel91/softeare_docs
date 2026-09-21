/**
 * The remote MCP error model (Phase 5, mission item 7).
 *
 * An agent cannot act on "the request failed". It can act on "someone else
 * wrote first — re-read and retry", or "you do not have the write scope", or
 * "that path is not allowed". So every failure the catalog can report is mapped
 * onto a small, closed vocabulary that the tool result carries both as text (for
 * the model) and as `structuredContent.error` (for a client that branches).
 *
 * The mapping is deliberately exhaustive and fail-closed:
 *
 * - an {@link ApplicationError} is translated by its transport-neutral code;
 * - anything else becomes `internal` with a generic message and the request's
 *   correlation id, so a database message, a filesystem path or a stack trace is
 *   never copied into a tool result. The detail goes to the server log.
 *
 * `unauthenticated` is not produced here: a bad or missing PAT is refused by the
 * HTTP transport with a 401 before any tool runs, which is where a machine
 * client expects to find it.
 */
import { ApplicationError } from "../../../src/application/errors";

/** The failure kinds a remote MCP client can distinguish. */
export type McpErrorCode =
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_path"
  | "validation"
  | "unavailable"
  | "internal";

/** A structured tool error. Never carries a secret or a server path. */
export interface McpToolError {
  code: McpErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Map an application error code onto the MCP vocabulary. */
function codeForApplicationError(error: ApplicationError): McpErrorCode {
  switch (error.code) {
    case "forbidden":
      return "forbidden";
    case "not_found":
      return "not_found";
    case "conflict":
      return "conflict";
    case "unavailable":
      return "unavailable";
    case "invalid":
      // The catalog tags a refused resource path so the distinction survives
      // the translation; every other `invalid` is an ordinary validation
      // failure the agent should fix and retry.
      return error.details?.kind === "invalid_path"
        ? "invalid_path"
        : "validation";
    case "unauthorized":
      // A use case should not report this (authentication is the transport's
      // job), but fail closed rather than inventing a category.
      return "forbidden";
    case "internal":
    default:
      return "internal";
  }
}

/**
 * Translate any thrown value into a tool error.
 *
 * `requestId` is used only when the failure is unexpected: it is the one piece
 * of context that lets an operator find the server-side detail without the
 * detail being sent to the client.
 */
export function toMcpError(error: unknown, requestId: string): McpToolError {
  if (error instanceof ApplicationError) {
    const mapped: McpToolError = {
      code: codeForApplicationError(error),
      message: error.message,
    };
    if (error.details !== undefined) {
      mapped.details = { ...error.details };
    }
    return mapped;
  }
  return {
    code: "internal",
    message: `The operation failed. Reference: ${requestId}.`,
    details: { requestId },
  };
}

/** Render a tool error as the text block a model reads. */
export function describeMcpError(error: McpToolError): string {
  return `Error (${error.code}): ${error.message}`;
}
