/**
 * Mapping application failures onto HTTP (ADR-040).
 *
 * Every use case reports a transport-neutral {@link ApplicationError}, and this
 * is the one place that decides what the wire looks like. Keeping the mapping in
 * a single function is what stops a controller from inventing a status, and what
 * keeps the MCP adapter's mapping independent of it — both read the same code,
 * neither decides it.
 *
 * An unexpected throw is a 500 whose body carries only a correlation id: the
 * detail belongs in the log, not in a response body.
 */
import { ApplicationError } from "../../../src/application/errors";
import { errorResponse, type ServerResponse } from "./http";

/** Options for mapping a failure. */
export interface ErrorMappingOptions {
  requestId: string;
  /** Called for a failure that is not a deliberate `ApplicationError`. */
  onUnexpected?: (error: unknown, requestId: string) => void;
}

/** Turn any thrown value into a response. */
export function toErrorResponse(
  error: unknown,
  options: ErrorMappingOptions,
): ServerResponse {
  if (error instanceof ApplicationError) {
    const headers =
      error.code === "unauthorized"
        ? [
            {
              name: "www-authenticate",
              value: 'Bearer realm="sequencediagrams"',
            },
          ]
        : [];
    return errorResponse(
      error.status,
      error.code,
      error.message,
      error.details,
      headers,
    );
  }
  options.onUnexpected?.(error, options.requestId);
  return errorResponse(
    500,
    "internal_error",
    "The request could not be completed.",
    {
      requestId: options.requestId,
    },
  );
}

/** Run a handler, mapping a failure instead of letting it escape. */
export async function guarded(
  requestId: string,
  work: () => Promise<ServerResponse>,
  onUnexpected?: (error: unknown, requestId: string) => void,
): Promise<ServerResponse> {
  try {
    return await work();
  } catch (error) {
    return toErrorResponse(error, { requestId, onUnexpected });
  }
}
