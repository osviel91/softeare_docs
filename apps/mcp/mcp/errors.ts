/**
 * The MCP tool error model (Phase 6 §20, §52).
 *
 * An agent cannot act on "the request failed". It can act on "someone else wrote
 * first — re-read and retry", or "you do not have the write scope", or "that
 * path is not allowed". Every failure the catalog can report is mapped onto a
 * small, closed vocabulary the tool result carries both as text (for the model)
 * and as `structuredContent.error` (for a client that branches).
 *
 * The mapping is exhaustive and fail-closed: an {@link ApplicationError} is
 * translated by its transport-neutral code, and anything else becomes `internal`
 * with a generic message and the request's correlation id, so a database
 * message, a filesystem path or a stack trace never reaches a tool result.
 *
 * `unauthenticated` is not produced here: a bad or missing PAT is refused by the
 * HTTP layer with a `401` before any tool runs, which is where a machine client
 * expects to find it.
 */
import { ApplicationError } from "../../../src/application/errors";

/** The failure kinds an MCP client can distinguish. */
export type McpErrorCode =
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_path"
  | "validation"
  | "unavailable"
  | "cancelled"
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
    case "invalid": {
      const kind = error.details?.kind;
      if (kind === "invalid_path") return "invalid_path";
      return "validation";
    }
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
    if (error.details !== undefined) mapped.details = { ...error.details };
    return mapped;
  }
  if (isAbort(error)) {
    return {
      code: "cancelled",
      message: "The operation was cancelled before it completed.",
    };
  }
  return {
    code: "internal",
    message: `The operation failed. Reference: ${requestId}.`,
    details: { requestId },
  };
}

/** Whether a thrown value is an abort. */
function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** Render a tool error as the text block a model reads. */
export function describeMcpError(error: McpToolError): string {
  return `Error (${error.code}): ${error.message}`;
}
