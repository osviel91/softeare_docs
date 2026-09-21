/**
 * The identity and correlation a use case runs under.
 *
 * Three rules make the shared application layer possible:
 *
 * 1. **Identity is decided at the edge, once.** An HTTP controller, an MCP
 *    request handler and the local-mode none-principal all produce a
 *    {@link Principal}; nothing below the edge ever sees a header, a cookie, an
 *    `Authorization: Bearer` value, or a stdio frame.
 * 2. **Use cases receive an {@link ApplicationContext}, never a transport.**
 *    The context is plain data, so a use case is exercisable from a unit test
 *    with no server running.
 * 3. **A caller is an actor acting for a subject.** The *subject* is the user
 *    whose authority is the upper bound; the *actor* is who is actually asking —
 *    that same user, or an agent on their behalf. Authorization always reasons
 *    about the subject's membership; audit records both.
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

/**
 * Who is acting.
 *
 * A human session acts as themselves; a credential acts as the agent it
 * belongs to. Keeping this explicit is what lets an audit trail say
 * "Hermes Documentation, on behalf of Osvi" without guessing from an auth type.
 */
export type Actor =
  | { kind: "user"; userId: UserId }
  | { kind: "agent"; agentId: string; credentialId: string };

/** An authenticated (or explicitly anonymous) caller, transport-independent. */
export interface Principal {
  /**
   * The user whose authority this request is bounded by. For a session this is
   * the signed-in user; for an agent credential it is the agent's owner.
   */
  subjectUserId: UserId;
  /** Who is actually asking — the subject, or an agent acting for them. */
  actor: Actor;
  /** Which mechanism established this principal. */
  authType: AuthType;
  /** The capabilities this credential carries, expanded to permissions. */
  scopes: readonly Scope[];
  /** A human-readable label for audit and UI (display name or agent name). */
  displayName?: string;
  /** Email, when the identity provider supplies one. Advisory, not identity. */
  email?: string;
  /**
   * Projects this credential is restricted to. Absent or empty means "no
   * restriction beyond membership", which is the session case.
   *
   * A restriction only ever *narrows*: it is intersected with the subject's
   * live membership and can never grant access the user does not have.
   */
  allowedProjectIds?: readonly string[];
}

export interface ApplicationContext {
  /** Who is asking. */
  principal: Principal;
  /** Correlation id for logs and the audit trail. */
  requestId: RequestId;
}

/** The principal used by local-first mode, which has no authentication at all. */
export const LOCAL_PRINCIPAL: Principal = {
  subjectUserId: "local",
  actor: { kind: "user", userId: "local" },
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

/** Whether this principal is an agent acting for its owner. */
export function isAgentActor(principal: Principal): boolean {
  return principal.actor.kind === "agent";
}

/** The acting agent's id, or `null` for a human actor. */
export function agentIdOf(principal: Principal): string | null {
  return principal.actor.kind === "agent" ? principal.actor.agentId : null;
}

/** The kind of actor, for an audit row. */
export type ActorType = "user" | "agent" | "system";

/** The actor kind an audit row records. */
export function actorTypeOf(principal: Principal): ActorType {
  return principal.actor.kind === "agent" ? "agent" : "user";
}

/**
 * The acting entity's id, for an audit row.
 *
 * For a human that is the user id (equal to {@link Principal.subjectUserId});
 * for an agent it is the agent id, which is *not* the subject — the subject is
 * the owner the agent acts for.
 */
export function actorIdOf(principal: Principal): string {
  return principal.actor.kind === "agent"
    ? principal.actor.agentId
    : principal.actor.userId;
}

/** The credential an agent actor authenticated with, or `null`. */
export function credentialIdOf(principal: Principal): string | null {
  return principal.actor.kind === "agent" ? principal.actor.credentialId : null;
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
