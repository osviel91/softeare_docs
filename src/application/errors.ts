/**
 * The application layer's error vocabulary.
 *
 * A use case reports *what went wrong in domain terms* — not an HTTP status and
 * not an MCP error code. Each transport maps a {@link ApplicationErrorCode} to
 * its own surface (404/409/403 for REST, a tool-execution error for MCP), which
 * is what lets one use case serve both without knowing either exists.
 *
 * Expected failures still travel as {@link Result} values inside the domain and
 * persistence layers (see `src/shared/result/result.ts`). An
 * {@link ApplicationError} is thrown only at the use-case boundary, where a
 * caller is a transport that must translate it anyway.
 */

/** The domain-level failure kinds a use case can report. */
export type ApplicationErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "unavailable"
  | "internal";

/** The HTTP status each failure kind maps to. */
export const HTTP_STATUS_BY_CODE: Readonly<
  Record<ApplicationErrorCode, number>
> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid: 422,
  unavailable: 503,
  internal: 500,
};

/** A failure a use case reports to its caller, with transport-neutral meaning. */
export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  /** Extra machine-readable context (never secrets). */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ApplicationErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.details = details;
  }

  /** The HTTP status this failure maps to. */
  get status(): number {
    return HTTP_STATUS_BY_CODE[this.code];
  }
}

/** No usable credential was presented. */
export function unauthorized(message = "Authentication is required.") {
  return new ApplicationError("unauthorized", message);
}

/** The caller is authenticated but not permitted to do this. */
export function forbidden(message = "You are not permitted to do that.") {
  return new ApplicationError("forbidden", message);
}

/** The addressed project, resource, or user does not exist (or is invisible). */
export function notFound(message: string) {
  return new ApplicationError("not_found", message);
}

/**
 * The caller's view of a resource is stale — someone else wrote first.
 *
 * Optimistic concurrency: the update carried an `expectedRevision` that no
 * longer matches, so applying it would silently overwrite another writer's
 * change. The caller must re-read and retry.
 */
export function revisionConflict(
  expectedRevision: number,
  currentRevision: number,
  message?: string,
) {
  return new ApplicationError(
    "conflict",
    message ??
      `The resource changed since it was read: expected revision ${expectedRevision}, current revision ${currentRevision}. Re-read it and retry.`,
    { expectedRevision, currentRevision },
  );
}

/** The request was well-formed but violates a rule. */
export function invalid(message: string, details?: Record<string, unknown>) {
  return new ApplicationError("invalid", message, details);
}

/**
 * The request cannot be applied because it clashes with current state.
 *
 * Distinct from {@link revisionConflict}: this is "a resource is already at that
 * path", "another operation is still finishing", or another clash that is not a
 * stale revision. `details.retryable` marks the ones a client may simply retry.
 */
export function conflict(message: string, details?: Record<string, unknown>) {
  return new ApplicationError("conflict", message, details);
}

/** Narrow an unknown thrown value into an {@link ApplicationError}. */
export function asApplicationError(
  error: unknown,
  fallback: ApplicationErrorCode = "internal",
): ApplicationError {
  if (error instanceof ApplicationError) return error;
  const message =
    error instanceof Error && error.message !== ""
      ? error.message
      : "The operation failed.";
  return new ApplicationError(fallback, message);
}
