/**
 * The API's failure vocabulary, on the client side (Phase 4A).
 *
 * The server answers a failed request with `{ error: { code, message, details } }`
 * where `code` is a transport-neutral {@link ApplicationErrorCode}. React code
 * must not branch on a status number: it would scatter `if (response.status ===
 * 409)` through components and quietly drift the moment the server changes an
 * edge. Instead the client maps the wire body onto typed errors *once*, at the
 * boundary, and everything above it asks `error instanceof RevisionConflictError`.
 *
 * The translation is deliberately lossy in one direction only: an unknown status
 * still becomes a typed {@link ApiError}, so no caller ever has to handle a raw
 * `Response`, but only the failures a UI can act on get a dedicated class.
 */

/** The failure kinds the server reports, mirrored from its `ApplicationError`. */
export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "unavailable"
  | "internal";

/** A failure the API reported, carrying its status and machine-readable code. */
export class ApiError extends Error {
  /** The HTTP status the server answered with. */
  readonly status: number;
  /** The server's transport-neutral failure code. */
  readonly code: string;
  /** Extra machine-readable context the server attached, if any. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** No usable session: the browser must sign in. */
export class AuthenticationRequiredError extends ApiError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(401, "unauthorized", message, details);
    this.name = "AuthenticationRequiredError";
  }
}

/** The caller is authenticated but not permitted to do this. */
export class AccessDeniedError extends ApiError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(403, "forbidden", message, details);
    this.name = "AccessDeniedError";
  }
}

/** The addressed project or resource does not exist (or is invisible). */
export class ResourceNotFoundError extends ApiError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(404, "not_found", message, details);
    this.name = "ResourceNotFoundError";
  }
}

/** The request was well-formed but violated a rule. */
export class ValidationFailedError extends ApiError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(422, "invalid", message, details);
    this.name = "ValidationFailedError";
  }
}

/** The server could not complete the request. Retrying is reasonable. */
export class ServerError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(status, code, message, details);
    this.name = "ServerError";
  }
}

/**
 * The caller's view of a resource is stale — someone else wrote first.
 *
 * This is the one failure a UI must handle specially rather than report: the
 * edit is *not* lost, and the user has to choose between re-reading and keeping
 * their buffer. {@link currentRevision} is what makes the choice concrete: it is
 * the revision the server holds now, so a later merge can be built on it without
 * guessing.
 */
export class RevisionConflictError extends ApiError {
  /** The revision the caller said it last read, when the server named it. */
  readonly expectedRevision: number | null;
  /** The revision the server holds now, when the server named it. */
  readonly currentRevision: number | null;

  constructor(
    message: string,
    options: {
      expectedRevision?: number | null;
      currentRevision?: number | null;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(409, "conflict", message, options.details ?? {});
    this.name = "RevisionConflictError";
    this.expectedRevision = options.expectedRevision ?? null;
    this.currentRevision = options.currentRevision ?? null;
  }
}

/**
 * The request never reached the server, or its answer did not arrive.
 *
 * Deliberately *not* an {@link ApiError}: nothing about the request was refused,
 * so there is no status and no code, and treating a dead network as a server
 * verdict would make a retry look like a rejected write. A caller must keep the
 * user's content and offer another attempt.
 */
export class NetworkError extends Error {
  /**
   * The underlying failure, when the platform supplied one.
   *
   * Named `reason` rather than `cause` so it does not collide with the built-in
   * `Error.cause` slot, which a caller reading this error should not have to
   * know about.
   */
  readonly reason: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = "NetworkError";
    this.reason = reason;
  }
}

/** Read a numeric field from an error body's `details`, or `null`. */
function numberDetail(
  details: Record<string, unknown>,
  name: string,
): number | null {
  const value = details[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Turn a failed response's status and body into a typed error.
 *
 * An unrecognised status still produces an {@link ApiError}, so the client
 * boundary has exactly one way to report a refusal and no call site has to
 * inspect a `Response`.
 */
export function apiErrorFromResponse(status: number, body: unknown): ApiError {
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error?: unknown }).error
      : undefined;
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const code = typeof record.code === "string" ? record.code : "internal_error";
  const message =
    typeof record.message === "string" && record.message !== ""
      ? record.message
      : `The request failed with status ${status}.`;
  const details =
    typeof record.details === "object" && record.details !== null
      ? (record.details as Record<string, unknown>)
      : {};

  switch (code) {
    case "unauthorized":
      return new AuthenticationRequiredError(message, details);
    case "forbidden":
      return new AccessDeniedError(message, details);
    case "not_found":
      return new ResourceNotFoundError(message, details);
    case "invalid":
      return new ValidationFailedError(message, details);
    case "conflict":
      return new RevisionConflictError(message, {
        expectedRevision: numberDetail(details, "expectedRevision"),
        currentRevision: numberDetail(details, "currentRevision"),
        details,
      });
    default:
      return new ServerError(status, code, message, details);
  }
}
