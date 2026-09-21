/**
 * The identity and correlation a use case runs under.
 *
 * Two rules make the shared application layer possible:
 *
 * 1. **Identity is decided at the edge, once.** An HTTP controller, an MCP
 *    request handler and the local-mode none-principal all produce a
 *    {@link Principal}; nothing below the edge ever sees a header, a cookie, an
 *    `Authorization: Bearer` value, or a stdio frame.
 * 2. **Use cases receive an {@link ApplicationContext}, never a transport.**
 *    The context is plain data, so a use case is exercisable from a unit test
 *    with no server running.
 *
 * The vocabulary of permissions lives in `src/domain/access/permissions.ts`;
 * the decision function that consumes a principal lives in
 * `src/domain/access/authorize.ts`. This module only carries them.
 */
import type { Permission, Scope } from "../domain/access/permissions";

/** A stable user identifier (a UUID in the server model). */
export type UserId = string;

/** How the caller proved who they are. */
export type AuthType = "session" | "oauth" | "pat" | "local";

/** A correlation id threaded through logs and audit records. */
export type RequestId = string;

/** An authenticated (or explicitly anonymous) caller, transport-independent. */
export interface Principal {
  /** The internal user id. Never an email address, never an issuer subject. */
  userId: UserId;
  /** Which mechanism established this principal. */
  authType: AuthType;
  /** The capabilities this credential carries. */
  scopes: readonly Scope[];
  /** A human-readable label for audit and UI (display name or token name). */
  displayName?: string;
  /** Email, when the identity provider supplies one. Advisory, not identity. */
  email?: string;
  /** The PAT or OAuth client this principal came from, when there is one. */
  credentialId?: string;
  /**
   * Projects this credential is restricted to. Absent or empty means "no
   * restriction beyond membership", which is the session case.
   */
  projectIds?: readonly string[];
}

export interface ApplicationContext {
  /** Who is asking. */
  principal: Principal;
  /** Correlation id for logs and the audit trail. */
  requestId: RequestId;
}

/** The principal used by local-first mode, which has no authentication at all. */
export const LOCAL_PRINCIPAL: Principal = {
  userId: "local",
  authType: "local",
  scopes: [],
  displayName: "Local workspace",
};

/**
 * Build a context for a local-mode call (the browser app and the stdio MCP
 * server). Local mode performs no authentication and no authorization, so the
 * principal is explicit about that rather than pretending to be a user.
 */
export function localContext(
  requestId = "local",
  scopes: readonly Scope[] = [],
): ApplicationContext {
  return {
    principal: { ...LOCAL_PRINCIPAL, scopes },
    requestId,
  };
}

/** Whether every permission in `wanted` is present in a scope list. */
export function hasAllScopes(
  scopes: readonly Scope[],
  wanted: readonly Scope[],
): boolean {
  return wanted.every((scope) => scopes.includes(scope));
}

/** Whether any permission in `wanted` is present in a scope list. */
export function hasAnyScope(
  scopes: readonly Scope[],
  wanted: readonly Permission[],
): boolean {
  return wanted.some((scope) => scopes.includes(scope as Scope));
}
