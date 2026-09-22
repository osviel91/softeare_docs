/**
 * The API's edge: identity in, `ApplicationContext` out (ADR-040).
 *
 * This is where the second architectural rule is enforced — *identity is decided
 * once, at the edge*. A controller never reads a cookie, a header or a bearer
 * token; it receives an {@link ApplicationContext} that was already built here,
 * and every use case below takes that context.
 *
 * The session credential is a server-side record. The cookie carries a secret of
 * the form `sid_<id>.<random>`; the database stores only its hash, so a database
 * read cannot be replayed as a login, and logging out (or revoking a session)
 * invalidates it immediately.
 */
import { createHash, randomBytes } from "node:crypto";
import type {
  ApplicationContext,
  AuthType,
  Principal,
} from "../../src/application/context";
import { forbidden, unauthorized } from "../../src/application/errors";
import type {
  SessionRepository,
  SessionWithUser,
} from "../../src/persistence/session-repository";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import type { Permission } from "../../src/domain/access/permissions";
import { constantTimeEquals } from "./auth/secret-compare";
import type { ServerRequest } from "./http/http";
import { correlationId } from "./http/node-server";

/** The cookie a browser session rides in. */
export const SESSION_COOKIE = "sdm_session";

/** The public part of a session token, used to find its row. */
export function sessionIdOf(token: string): string | null {
  const match = /^sid_([0-9a-fA-F-]{36})\.[A-Za-z0-9_-]{16,}$/.exec(token);
  return match === null ? null : match[1];
}

/**
 * Hash a session secret.
 *
 * A single SHA-256 is right here, and would be wrong for a password: the secret
 * is 256 bits of uniform randomness that only this server ever sees, so there is
 * nothing to guess and no dictionary to try. The hash exists so that a leaked
 * database cannot be replayed as a live session.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mint a new session secret. */
export function createSessionToken(sessionId: string): string {
  return `sid_${sessionId}.${randomBytes(32).toString("base64url")}`;
}

/** Compare two hex digests without leaking their length relationship. */
export const hashesMatch = constantTimeEquals;

/** What a session lookup found. */
export type SessionLookup =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "valid"; session: SessionWithUser };

/** Resolve the session cookie on a request. */
export async function resolveSession(
  sessions: SessionRepository,
  request: ServerRequest,
): Promise<SessionLookup> {
  const raw = request.cookies[SESSION_COOKIE];
  if (raw === undefined || raw === "") return { state: "none" };
  const sessionId = sessionIdOf(raw);
  if (sessionId === null) return { state: "invalid" };
  const record = await sessions.findById(sessionId);
  if (!record) return { state: "invalid" };
  if (!hashesMatch(record.tokenHash, hashSessionToken(raw))) {
    return { state: "invalid" };
  }
  if (record.revokedAt !== null) return { state: "invalid" };
  if (record.expiresAt.getTime() <= Date.now()) return { state: "invalid" };
  if (record.user.status === "SUSPENDED") return { state: "invalid" };
  return { state: "valid", session: record };
}

/**
 * The permissions a browser session carries.
 *
 * A session is a human at a browser, and a human's authority is their project
 * membership — resolved per project by the authorization layer, not baked into a
 * credential. The scope list is therefore the full vocabulary, named once in
 * `permissions.ts` rather than re-listed here, and the *role* check is what
 * constrains it.
 */
export const SESSION_SCOPES: readonly Permission[] = ALL_PERMISSIONS;

/**
 * The context for an unauthenticated request.
 *
 * Never used to run a use case — it exists so that `/api/me` can answer
 * "nobody" without pretending somebody is there, and so an unauthenticated
 * request has a correlation id like any other.
 */
export function anonymousContext(request: ServerRequest): ApplicationContext {
  return {
    requestId: correlationId(request),
    principal: {
      subjectUserId: "anonymous",
      actor: { kind: "user", userId: "anonymous" },
      authType: "session",
      scopes: [],
    },
  };
}

/** Build a principal from a session's user. */
export function principalFromSession(session: SessionWithUser): Principal {
  const principal: Principal = {
    subjectUserId: session.user.id,
    actor: { kind: "user", userId: session.user.id },
    authType: "session",
    scopes: SESSION_SCOPES,
  };
  if (session.user.displayName !== "")
    principal.displayName = session.user.displayName;
  if (session.user.email !== null) principal.email = session.user.email;
  principal.accountStatus = session.user.status;
  principal.platformAdmin = session.user.platformAdmin;
  return principal;
}

/**
 * The authenticated context for a request, or a 401-mapped failure.
 *
 * @throws {ApplicationError} `unauthorized` when there is no usable session.
 */
export async function requireContext(
  sessions: SessionRepository,
  request: ServerRequest,
): Promise<ApplicationContext> {
  const lookup = await resolveSession(sessions, request);
  if (lookup.state === "none") {
    throw unauthorized("Sign in to continue.");
  }
  if (lookup.state === "invalid") {
    throw unauthorized("Your session is no longer valid. Sign in again.");
  }
  if (lookup.session.user.status !== "ACTIVE" && !lookup.session.user.platformAdmin) {
    throw forbidden("Your account is awaiting administrator approval.");
  }
  // Touching `last_seen_at` is best-effort: a write failure must not fail a
  // request that is otherwise authorized.
  await sessions.touch(lookup.session.id).catch(() => {});
  return {
    requestId: correlationId(request),
    principal: principalFromSession(lookup.session),
  };
}

/** A context built from an already-resolved principal, for tests and reuse. */
export function contextFor(
  principal: Principal,
  requestId: string,
): ApplicationContext {
  return { principal, requestId };
}

/** The auth types a context can carry, for logging. */
export function authTypeOf(context: ApplicationContext): AuthType {
  return context.principal.authType;
}
