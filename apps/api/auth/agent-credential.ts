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
 * ## Phase 6: this module is now an adapter, not an implementation
 *
 * The format, digest, verification and principal construction moved to
 * `src/persistence/agent-authentication.ts`, because the remote MCP service
 * needs exactly the same check and hosts may not import each other (ADR-039).
 * What remains here is the one thing that is genuinely API-shaped: pulling an
 * `Authorization: Bearer …` value out of this host's {@link ServerRequest}.
 * There is no second verifier and no second hash — `verifyMcpPat()` does not
 * exist, which is the mission's item 10.
 */
import type { ApplicationContext } from "../../../src/application/context";
import { unauthorized } from "../../../src/application/errors";
import type { AgentCredentialRepository } from "../../../src/application/ports/agent-repository";
import {
  authenticateBearerToken,
  createPatBearerVerifier,
  resolveAgentCredentialToken,
  type AgentCredentialLookup,
} from "../../../src/persistence/agent-authentication";
import { correlationId } from "../http/node-server";
import type { ServerRequest } from "../http/http";

export {
  AGENT_PREFIX_BYTES,
  AGENT_SECRET_BYTES,
  AGENT_TOKEN_PREFIX,
  agentPrefixOf,
  createCredentialMint,
  hashAgentToken,
  principalFromCredential,
  type AgentCredentialLookup,
} from "../../../src/persistence/agent-authentication";

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

/**
 * Resolve a bearer credential on a request.
 *
 * Kept with its Phase 5 signature so existing callers and tests are unchanged;
 * the work is the shared {@link resolveAgentCredentialToken}.
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
  return resolveAgentCredentialToken(credentials, extracted.token, pepper, now);
}

/**
 * The authenticated context for a bearer request, or a 401-mapped failure.
 *
 * A session cookie is deliberately *not* consulted: this is the machine
 * surface, and letting an ambient browser cookie authenticate it would turn a
 * same-site `fetch` into an agent call.
 *
 * The token goes through the shared verifier chain — built here with the PAT
 * verifier alone. Phase 7 appends an OAuth verifier to the same chain and
 * neither this function's callers nor the application layer change.
 *
 * @throws {ApplicationError} `unauthorized` when no usable credential was presented.
 */
export async function requireBearerContext(
  credentials: AgentCredentialRepository,
  request: ServerRequest,
  pepper: string,
  now?: () => Date,
): Promise<ApplicationContext> {
  const extracted = bearerTokenOf(request);
  if (extracted.state === "none") {
    throw unauthorized("A personal access token is required.");
  }
  if (extracted.state === "invalid") {
    throw unauthorized("The personal access token is invalid or has expired.");
  }
  const verifier = createPatBearerVerifier(credentials, pepper, {
    ...(now === undefined ? {} : { now }),
  });
  const principal = await authenticateBearerToken([verifier], extracted.token);
  if (principal === null) {
    throw unauthorized("The personal access token is invalid or has expired.");
  }
  return { requestId: correlationId(request), principal };
}
