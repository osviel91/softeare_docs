/**
 * Bearer authentication, independent of any transport.
 *
 * Both the API and MCP service use this shared implementation to authenticate a
 * personal access token without either host importing the other.
 *
 * ## The seam a second verifier slots into
 *
 * Authentication is a chain of {@link BearerVerifier}s. The application layer
 * never learns which verifier answered; it only ever sees a {@link Principal}.
 *
 * ## What is deliberately not here
 *
 * Nothing reads an HTTP header. Extracting `Authorization` is the caller's job,
 * because the API's request type and the MCP service's request type are
 * different objects. This module takes a token *string*.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Principal } from "../application/context";
import type { MintedCredential } from "../application/agent-service";
import type { AgentCredentialRepository } from "../application/ports/agent-repository";
import type {
  AgentCredential,
  AgentCredentialWithAgent,
  AgentIdentity,
} from "../domain/agent/agent";
import { isCredentialUsable } from "../domain/agent/agent";
import { permissionsOfCredentialScopes } from "../domain/access/permissions";
import { constantTimeEquals } from "./constant-time";

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

/**
 * Hash a full token string for storage or verification, keyed by the pepper.
 *
 * `HMAC-SHA-256(pepper, token)` — a keyed, reviewed construction rather than a
 * custom one. A slow password hash is unnecessary: the secret is 256 bits of
 * uniform randomness, so there is no dictionary to try.
 */
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

/** What a credential verification found. */
export type AgentCredentialLookup =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "valid"; credential: AgentCredential; agent: AgentIdentity };

/**
 * Resolve a bearer token string against the credential store.
 *
 * A row that is missing, revoked, expired, owned by a disabled agent, or whose
 * digest does not match is `invalid` — the same answer in every case.
 * Distinguishing "expired" from "wrong secret" would tell an attacker that a
 * prefix is real, and the client can do nothing different in either case.
 *
 * A token that is not even shaped like a credential is `invalid` rather than
 * `none`: the caller presented *something*, and answering "you presented
 * nothing" would invite a second, weaker verifier to try it.
 */
export async function resolveAgentCredentialToken(
  credentials: AgentCredentialRepository,
  token: string,
  pepper: string,
  now: () => Date = () => new Date(),
): Promise<AgentCredentialLookup> {
  if (token === "") return { state: "invalid" };
  const prefix = agentPrefixOf(token);
  if (prefix === null) return { state: "invalid" };

  const found = await credentials.findByPrefix(prefix);
  if (!found) return { state: "invalid" };
  if (
    !constantTimeEquals(
      found.credential.secretHash,
      hashAgentToken(pepper, token),
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
 * One way of turning a bearer token into a principal.
 *
 * A verifier must never throw for a token it simply does not recognise: it
 * returns `null` so the next verifier in the chain can try. A storage failure
 * *is* allowed to propagate, because the alternative — a chain that treats "the
 * database is down" as "not my token" — would let a later verifier accept a
 * credential the first could not check.
 */
export interface BearerVerifier {
  /** A short, stable label for logs and metrics. Never a secret. */
  readonly kind: string;
  /** The principal this verifier authenticates for `token`, or `null`. */
  verify(token: string): Promise<Principal | null>;
}

/** Whether a token is shaped like a personal access token. */
export function looksLikeAgentToken(token: string): boolean {
  return agentPrefixOf(token) !== null;
}

/**
 * A verifier over the agent-credential store.
 *
 * `accepts` is a cheap shape test so a token minted by a *different* authority
 * is not looked up in this table at all; the digest comparison is the real
 * check and runs only after the prefix resolves.
 */
export function createPatBearerVerifier(
  credentials: AgentCredentialRepository,
  pepper: string,
  options: { now?: () => Date; accepts?: (token: string) => boolean } = {},
): BearerVerifier {
  const accepts = options.accepts ?? looksLikeAgentToken;
  return {
    kind: "pat",
    async verify(token) {
      if (!accepts(token)) return null;
      const lookup = await resolveAgentCredentialToken(
        credentials,
        token,
        pepper,
        options.now,
      );
      if (lookup.state !== "valid") return null;
      return principalFromCredential(lookup.credential, lookup.agent);
    },
  };
}

/**
 * Authenticate a bearer token through the verifier chain.
 *
 * Returns `null` when no verifier claims the token. The chain is ordered, and
 * the first verifier that returns a principal wins; a verifier that does not
 * recognise the token must return `null` rather than a refusal, so additional
 * verifiers can be composed without changing the existing verifier's behavior.
 */
export async function authenticateBearerToken(
  verifiers: readonly BearerVerifier[],
  token: string,
): Promise<Principal | null> {
  for (const verifier of verifiers) {
    const principal = await verifier.verify(token);
    if (principal !== null) return principal;
  }
  return null;
}

/** Re-exported so a caller can name the lookup result without a deep import. */
export type { AgentCredentialWithAgent };
