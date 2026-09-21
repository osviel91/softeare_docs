/**
 * The MCP authentication boundary (Phase 6 §8–10, §52, §76).
 *
 * This is the only place in the MCP service that looks at an `Authorization`
 * header. Everything below it receives a {@link Principal} and never learns
 * which verifier produced it — which is exactly what lets Phase 7 append an
 * OAuth access-token verifier without touching a single tool.
 *
 * ## Only a bearer PAT counts
 *
 * A browser session cookie is deliberately *not* consulted, and its presence
 * without a bearer token is a `401`, not an anonymous request. That keeps the
 * machine surface free of CSRF ambiguity and stops a same-site browser `fetch`
 * from turning an ambient cookie into an agent call (mission §9).
 *
 * ## Failure vocabulary (mission §52)
 *
 * - no credential at all → `401` with a challenge
 * - malformed, revoked, expired or disabled-agent credential → `401`
 * - a valid credential without the required scope → `403` (raised by the use
 *   case, not here)
 * - an unknown or invisible project → `404` (raised by the use case)
 */
import type { Principal } from "../../../src/application/context";
import {
  authenticateBearerToken,
  createPatBearerVerifier,
  looksLikeAgentToken,
  type BearerVerifier,
} from "../../../src/persistence/agent-authentication";
import type { AgentCredentialRepository } from "../../../src/application/ports/agent-repository";

/** What extracting a bearer token from headers produced. */
export type BearerExtraction =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "present"; token: string };

/**
 * Extract a bearer token from a lower-cased header record.
 *
 * Only `Bearer` is accepted. Anything else — `Basic`, a bare token, a cookie —
 * is `invalid` rather than `none`, so a misconfigured client gets a refusal
 * instead of an anonymous request that appears to half-work.
 */
export function bearerTokenOfHeaders(
  headers: Readonly<Record<string, string>>,
): BearerExtraction {
  const header = headers.authorization;
  if (header === undefined || header.trim() === "") return { state: "none" };
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (match === null) return { state: "invalid" };
  const token = match[1].trim();
  if (token === "") return { state: "invalid" };
  return { state: "present", token };
}

/** Why a request was refused, for the response and for a metric label. */
export type AuthFailure = "missing" | "invalid";
/** The outcome of authenticating a request. */
export type AuthOutcome =
  | { state: "authenticated"; principal: Principal }
  | { state: "refused"; reason: AuthFailure };

/** A verifier that can look up a credential and produce a principal. */
export interface McpAuthenticator {
  authenticate(headers: Readonly<Record<string, string>>): Promise<AuthOutcome>;
}

/** Options for the MCP authenticator. */
export interface McpAuthenticatorOptions {
  credentials: AgentCredentialRepository;
  pepper: string;
  now?: () => Date;
  /**
   * Additional verifiers tried after the PAT verifier. Phase 7 supplies the
   * OAuth access-token verifier here; the function's contract does not change.
   */
  extraVerifiers?: readonly BearerVerifier[];
}

/**
 * Build the MCP authenticator over the shared credential store.
 *
 * The chain is explicit and ordered: a token that looks like a PAT is checked
 * against the PAT verifier first, and only a token the PAT verifier does *not*
 * claim is offered to a later verifier. There is no `verifyMcpPat()` anywhere —
 * this calls the same code the API's edge calls.
 */
export function createMcpAuthenticator(
  options: McpAuthenticatorOptions,
): McpAuthenticator {
  const pat = createPatBearerVerifier(options.credentials, options.pepper, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const verifiers: BearerVerifier[] = [pat, ...(options.extraVerifiers ?? [])];

  return {
    async authenticate(headers) {
      const extracted = bearerTokenOfHeaders(headers);
      if (extracted.state === "none") {
        return { state: "refused", reason: "missing" };
      }
      if (extracted.state === "invalid") {
        return { state: "refused", reason: "invalid" };
      }
      // A token that is not even PAT-shaped is still offered to the chain, so a
      // future OAuth verifier can claim it; today it simply resolves to none.
      const principal = await authenticateBearerToken(
        verifiers,
        extracted.token,
      );
      if (principal === null) {
        return { state: "refused", reason: "invalid" };
      }
      return { state: "authenticated", principal };
    },
  };
}

/** Whether a header record presents something that looks like an agent token. */
export function hasAgentToken(
  headers: Readonly<Record<string, string>>,
): boolean {
  const extracted = bearerTokenOfHeaders(headers);
  return extracted.state === "present" && looksLikeAgentToken(extracted.token);
}
