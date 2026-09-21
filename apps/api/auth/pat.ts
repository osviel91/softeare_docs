/**
 * Personal Access Tokens at the API edge (Phase 5).
 *
 * This module owns the *credential* half of a PAT: its wire format, generation,
 * hashing, verification, and the principal it produces. It is deliberately next
 * to the session code in `apps/api/context.ts` and mirrors it, because the two
 * must stay visibly separate:
 *
 * - a **session** is an ambient, browser-held `HttpOnly` cookie a person did not
 *   type; it is carried automatically and is meaningless outside a browser;
 * - a **PAT** is a bearer string a human copied into a machine's configuration.
 *   It is presented explicitly in `Authorization: Bearer …`, and it is *never*
 *   accepted from a cookie or a query parameter.
 *
 * ## Format
 *
 * ```
 * sdm_pat_<prefix>.<secret>
 * ```
 *
 * `prefix` is 16 hex characters (64 bits) and is public: it is the indexed key
 * the row is found by. `secret` is 43 base64url characters (256 bits of CSPRNG)
 * and is compared only through its SHA-256 digest, in constant time. Nothing
 * about the secret is logged, returned by a read, or stored.
 *
 * ## Why a plain SHA-256 and not a password hash
 *
 * The secret is 256 bits of uniform randomness that only this server ever
 * generates, so there is no dictionary to try and no work factor to buy. The
 * digest exists for one reason: a leaked database must not be replayable as a
 * live credential. This is the same reasoning the session secret uses.
 */
import { createHash, randomBytes } from "node:crypto";
import type {
  ApplicationContext,
  Principal,
} from "../../../src/application/context";
import { unauthorized } from "../../../src/application/errors";
import { permissionsOfPatScopes } from "../../../src/domain/access/permissions";
import type { PersonalAccessTokenRecord } from "../../../src/application/ports/personal-access-token-repository";
import type { PersonalAccessTokenRepository } from "../../../src/application/ports/personal-access-token-repository";
import { constantTimeEquals } from "./secret-compare";
import type { ServerRequest } from "../http/http";
import { correlationId } from "../http/node-server";

/** The literal a PAT starts with, so a leaked string is recognisable. */
export const PAT_PREFIX = "sdm_pat_";

/** The bytes of randomness in a token secret (256 bits). */
export const PAT_SECRET_BYTES = 32;

/** The bytes of randomness in the public prefix (64 bits). */
export const PAT_PREFIX_BYTES = 8;

/** The regular expression a well-formed token matches. */
const PAT_PATTERN = new RegExp(
  `^${PAT_PREFIX}([0-9a-f]{${PAT_PREFIX_BYTES * 2}})\\.([A-Za-z0-9_-]{20,128})$`,
);

/** A freshly generated token and the parts of it the server stores. */
export interface GeneratedPat {
  /** The full credential, shown to its owner exactly once. */
  token: string;
  /** The public lookup prefix. */
  prefix: string;
  /** The hex SHA-256 digest stored in place of the secret. */
  tokenHash: string;
}

/** Hash a full token string for storage or verification. */
export function hashPatToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The public prefix of a well-formed token, or `null`. */
export function patPrefixOf(token: string): string | null {
  const match = PAT_PATTERN.exec(token);
  return match === null ? null : match[1];
}

/**
 * Mint a new token.
 *
 * The prefix is generated here rather than derived from the id so the stored
 * lookup key and the database primary key are independent; a collision on the
 * unique prefix constraint is handled by the caller retrying, which is cheaper
 * than making the public half predictable.
 */
export function generatePat(): GeneratedPat {
  const prefix = randomBytes(PAT_PREFIX_BYTES).toString("hex");
  const secret = randomBytes(PAT_SECRET_BYTES).toString("base64url");
  const token = `${PAT_PREFIX}${prefix}.${secret}`;
  return { token, prefix, tokenHash: hashPatToken(token) };
}

/** What extracting a bearer credential from a request produced. */
export type BearerExtraction =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "present"; token: string };

/**
 * Extract a bearer token from the `Authorization` header.
 *
 * Only `Bearer` is accepted. Anything else — a `Basic` header, a bare token, a
 * session cookie — is `invalid` rather than `none`, so a remote MCP client that
 * misconfigures its credential gets a refusal instead of an anonymous request
 * that appears to half-work.
 */
export function bearerTokenOf(request: ServerRequest): BearerExtraction {
  const header = request.headers.authorization;
  if (header === undefined || header.trim() === "") return { state: "none" };
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (match === null) return { state: "invalid" };
  const token = match[1].trim();
  if (token === "") return { state: "invalid" };
  return { state: "present", token };
}

/** What a PAT verification found. */
export type PatLookup =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "valid"; record: PersonalAccessTokenRecord };

/**
 * Resolve a bearer credential on a request.
 *
 * A row that is missing, revoked, expired or whose digest does not match is
 * `invalid` — the same answer in every case. Distinguishing "expired" from
 * "wrong secret" would tell an attacker that a prefix is real, and the client
 * can do nothing different in either case.
 */
export async function resolvePat(
  tokens: PersonalAccessTokenRepository,
  request: ServerRequest,
  now: () => Date = () => new Date(),
): Promise<PatLookup> {
  const extracted = bearerTokenOf(request);
  if (extracted.state === "none") return { state: "none" };
  if (extracted.state === "invalid") return { state: "invalid" };

  const prefix = patPrefixOf(extracted.token);
  if (prefix === null) return { state: "invalid" };

  const record = await tokens.findByPrefix(prefix);
  if (!record) return { state: "invalid" };
  if (!constantTimeEquals(record.tokenHash, hashPatToken(extracted.token))) {
    return { state: "invalid" };
  }
  if (record.revokedAt !== null) return { state: "invalid" };
  if (
    record.expiresAt !== null &&
    record.expiresAt.getTime() <= now().getTime()
  ) {
    return { state: "invalid" };
  }

  // Recording use is best-effort: a write failure must not fail a request that
  // is otherwise authorized, exactly as `sessions.touch` is best-effort.
  await tokens.touch(record.id).catch(() => {});
  return { state: "valid", record };
}

/**
 * The principal a PAT produces.
 *
 * The token's *user* is the principal's identity; the token itself only narrows
 * what that identity may do. Scopes become permissions here, so the
 * authorization policy never learns that PATs exist, and a project restriction
 * becomes the same `projectIds` field the policy already understands.
 */
export function principalFromPat(record: PersonalAccessTokenRecord): Principal {
  const principal: Principal = {
    userId: record.userId,
    authType: "pat",
    scopes: permissionsOfPatScopes(record.scopes),
    credentialId: record.id,
    displayName: record.name,
  };
  if (record.projectIds !== null && record.projectIds.length > 0) {
    principal.projectIds = [...record.projectIds];
  }
  return principal;
}

/**
 * The authenticated context for a remote-MCP request, or a 401-mapped failure.
 *
 * Only a bearer PAT is accepted here. A session cookie is deliberately *not*
 * consulted: the remote MCP endpoint is a machine surface, and letting an
 * ambient browser cookie authenticate it would turn a same-site `fetch` into an
 * agent call.
 *
 * @throws {ApplicationError} `unauthorized` when no usable PAT was presented.
 */
export async function requireBearerContext(
  tokens: PersonalAccessTokenRepository,
  request: ServerRequest,
  now?: () => Date,
): Promise<ApplicationContext> {
  const lookup = await resolvePat(tokens, request, now);
  if (lookup.state === "none") {
    throw unauthorized("A personal access token is required.");
  }
  if (lookup.state === "invalid") {
    throw unauthorized("The personal access token is invalid or has expired.");
  }
  return {
    requestId: correlationId(request),
    principal: principalFromPat(lookup.record),
  };
}
