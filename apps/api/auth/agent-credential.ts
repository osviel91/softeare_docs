/**
 * Agent credential authentication at the API edge (ADR-043, Phase 5).
 *
 * The credential half of an agent: its wire format, generation, hashing,
 * verification, and the principal it produces. It deliberately mirrors the
 * session code in `apps/api/context.ts` so the two stay visibly separate:
 *
 * - a **session** is an ambient, browser-held `HttpOnly` cookie a person did
 *   not type; it is carried automatically and is meaningless outside a browser;
 * - an **agent credential** is a bearer string a human copied into a machine's
 *   configuration. It is presented explicitly in `Authorization: Bearer …`, and
 *   it is *never* accepted from a cookie or a query parameter.
 *
 * ## Format
 *
 * ```
 * sdm_pat_<publicPrefix>.<secret>
 * ```
 *
 * `publicPrefix` is 16 hex characters (64 bits) and is public: it is the
 * indexed key a credential row is found by. `secret` is 43 base64url characters
 * (256 bits of CSPRNG) and is compared only through its digest, in constant
 * time. The `.` separator (rather than the `_` the mission sketches) is chosen
 * because base64url secrets themselves contain `_`, which would make the split
 * ambiguous. Nothing about the secret is logged, returned by a read, or stored.
 *
 * ## Hash-at-rest
 *
 * The digest is `HMAC-SHA-256(server pepper, full token)` — a keyed, reviewed
 * construction, not a custom one. The pepper is a deployment secret
 * (`TOKEN_PEPPER`, defaulting to the cookie secret), so a stolen database alone
 * is not enough to check a guessed token against a stored digest. A slow
 * password hash is unnecessary: the secret is 256 bits of uniform randomness,
 * so there is no dictionary to try and no work factor to buy.
 */
import { createHmac, randomBytes } from "node:crypto";
import type {
  ApplicationContext,
  Principal,
} from "../../../src/application/context";
import { unauthorized } from "../../../src/application/errors";
import type { AgentCredentialRepository } from "../../../src/application/ports/agent-repository";
import type { MintedCredential } from "../../../src/application/agent-service";
import type {
  AgentCredential,
  AgentIdentity,
} from "../../../src/domain/agent/agent";
import { isCredentialUsable } from "../../../src/domain/agent/agent";
import { permissionsOfCredentialScopes } from "../../../src/domain/access/permissions";
import { constantTimeEquals } from "./secret-compare";
import type { ServerRequest } from "../http/http";
import { correlationId } from "../http/node-server";

/** The literal a credential starts with, so a leaked string is recognisable. */
export const AGENT_TOKEN_PREFIX = "sdm_pat_";

/** The bytes of randomness in a token secret (256 bits). */
export const AGENT_SECRET_BYTES = 32;

/** The bytes of randomness in the public prefix (64 bits). */
export const AGENT_PREFIX_BYTES = 8;

/** The regular expression a well-formed credential matches. */
const AGENT_TOKEN_PATTERN = new RegExp(
  `^${AGENT_TOKEN_PREFIX}([0-9a-f]{${AGENT_PREFIX_BYTES * 2}})\\.([A-Za-z0-9_-]{20,128})$`,
);

/** Hash a full token string for storage or verification, keyed by the pepper. */
export function hashAgentToken(pepper: string, token: string): string {
  return createHmac("sha256", pepper).update(token, "utf8").digest("hex");
}

/** The public prefix of a well-formed token, or `null`. */
export function agentPrefixOf(token: string): string | null {
  const match = AGENT_TOKEN_PATTERN.exec(token);
  return match === null ? null : match[1];
}

/**
 * A minting function bound to the deployment's pepper.
 *
 * The service calls it for each new credential; the returned plaintext is shown
 * once and the digest is what is stored.
 */
export function createCredentialMint(pepper: string): () => MintedCredential {
  return () => {
    const publicPrefix = randomBytes(AGENT_PREFIX_BYTES).toString("hex");
    const secret = randomBytes(AGENT_SECRET_BYTES).toString("base64url");
    const token = `${AGENT_TOKEN_PREFIX}${publicPrefix}.${secret}`;
    return { token, publicPrefix, secretHash: hashAgentToken(pepper, token) };
  };
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
 * session cookie — is `invalid` rather than `none`, so a client that
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

/** Whether a request presents a bearer credential at all. */
export function hasBearerCredential(request: ServerRequest): boolean {
  return bearerTokenOf(request).state !== "none";
}

/** What a credential verification found. */
export type AgentCredentialLookup =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "valid"; credential: AgentCredential; agent: AgentIdentity };

/**
 * Resolve a bearer credential on a request.
 *
 * A row that is missing, revoked, expired, owned by a disabled agent, or whose
 * digest does not match is `invalid` — the same answer in every case.
 * Distinguishing "expired" from "wrong secret" would tell an attacker that a
 * prefix is real, and the client can do nothing different in either case.
 */
export async function resolveAgentCredential(
  credentials: AgentCredentialRepository,
  request: ServerRequest,
  pepper: string,
  now: () => Date = () => new Date(),
): Promise<AgentCredentialLookup> {
  const extracted = bearerTokenOf(request);
  if (extracted.state === "none") return { state: "none" };
  if (extracted.state === "invalid") return { state: "invalid" };

  const prefix = agentPrefixOf(extracted.token);
  if (prefix === null) return { state: "invalid" };

  const found = await credentials.findByPrefix(prefix);
  if (!found) return { state: "invalid" };
  if (
    !constantTimeEquals(
      found.credential.secretHash,
      hashAgentToken(pepper, extracted.token),
    )
  ) {
    return { state: "invalid" };
  }
  if (!isCredentialUsable(found.credential, found.agent, now())) {
    return { state: "invalid" };
  }

  // Recording use is best-effort: a write failure must not fail a request that
  // is otherwise authorized, exactly as `sessions.touch` is best-effort.
  await credentials.touch(found.credential.id).catch(() => {});
  return {
    state: "valid",
    credential: found.credential,
    agent: found.agent,
  };
}

/**
 * The principal a credential produces.
 *
 * The *subject* is the agent's owner: authorization reasons about the owner's
 * live membership and can never be widened by the credential. The *actor* is
 * the agent, so the audit trail can say which automation acted.
 */
export function principalFromCredential(
  credential: AgentCredential,
  agent: AgentIdentity,
): Principal {
  const principal: Principal = {
    subjectUserId: agent.ownerUserId,
    actor: {
      kind: "agent",
      agentId: agent.id,
      credentialId: credential.id,
    },
    authType: "pat",
    scopes: permissionsOfCredentialScopes(credential.scopes),
    displayName: agent.name,
  };
  if (
    credential.allowedProjectIds !== null &&
    credential.allowedProjectIds.length > 0
  ) {
    principal.allowedProjectIds = [...credential.allowedProjectIds];
  }
  return principal;
}

/**
 * The authenticated context for a bearer request, or a 401-mapped failure.
 *
 * A session cookie is deliberately *not* consulted: this is the machine
 * surface, and letting an ambient browser cookie authenticate it would turn a
 * same-site `fetch` into an agent call.
 *
 * @throws {ApplicationError} `unauthorized` when no usable credential was presented.
 */
export async function requireBearerContext(
  credentials: AgentCredentialRepository,
  request: ServerRequest,
  pepper: string,
  now?: () => Date,
): Promise<ApplicationContext> {
  const lookup = await resolveAgentCredential(
    credentials,
    request,
    pepper,
    now,
  );
  if (lookup.state === "none") {
    throw unauthorized("A personal access token is required.");
  }
  if (lookup.state === "invalid") {
    throw unauthorized("The personal access token is invalid or has expired.");
  }
  return {
    requestId: correlationId(request),
    principal: principalFromCredential(lookup.credential, lookup.agent),
  };
}
