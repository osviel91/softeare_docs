/**
 * Agent identities and their credentials (ADR-043).
 *
 * The domain models authorization-relevant *identity*, not storage. A
 * {@link AgentIdentity} is a named automation principal owned by one user; an
 * {@link AgentCredential} is one way that agent proves who it is.
 *
 * ## Why an agent is not a user
 *
 * A user authenticates a human and owns projects. An agent never owns anything:
 * it acts *on behalf of* its owner, and every authorization decision resolves
 * the owner's live membership. That is what makes "the agent lost access when
 * the user did" automatic rather than a synchronization problem, and it is why
 * the principal carries both the subject user and the acting agent.
 *
 * ## Why credentials are separate from the agent
 *
 * An agent may hold several credentials — one per machine, one per environment,
 * one being rotated in — and each can be revoked, expire and be scoped
 * independently. Revoking a laptop's credential must not disable the agent's
 * other machines, which is impossible to express if the secret lives on the
 * agent record itself.
 *
 * These are plain data types: no method here reads a database, a hash or a
 * clock. The application service and the host's credential codec add those.
 */
import type { CredentialScope, Permission } from "../access/permissions";

/** A stable agent identifier (a UUID in the server model). */
export type AgentId = string;

/** A stable credential identifier (a UUID in the server model). */
export type CredentialId = string;

/**
 * A named automation principal owned by a user.
 *
 * `disabledAt` is the agent-level kill switch: disabling an agent invalidates
 * every one of its credentials immediately, without revoking each in turn.
 */
export interface AgentIdentity {
  id: AgentId;
  /** The user this agent acts on behalf of. Never a user itself. */
  ownerUserId: string;
  name: string;
  /** Optional prose, for a human reading the settings screen. */
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Set when the agent is disabled; `null` while it is active. */
  disabledAt: Date | null;
}

/**
 * One credential belonging to an agent.
 *
 * The secret is represented only by {@link secretHash}; the plaintext is never
 * a field of this type, so no code that handles a credential can accidentally
 * persist or return one.
 */
export interface AgentCredential {
  id: CredentialId;
  agentId: AgentId;
  name: string;
  /** The non-secret public identifier the token carries. Unique. */
  publicPrefix: string;
  /** A hex digest of the full token. Never the token itself. */
  secretHash: string;
  /** The scopes the credential was granted, as stored. */
  scopes: readonly CredentialScope[];
  /**
   * The projects this credential is restricted to, or `null` for "no narrowing
   * beyond the owner's membership". Restriction only ever removes access.
   */
  allowedProjectIds: readonly string[] | null;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * A credential plus the agent and owner it belongs to.
 *
 * The verification path needs all three together: the agent to check the
 * disabled flag, the credential for its secret and scopes, and the owner as the
 * principal's subject.
 */
export interface AgentCredentialWithAgent {
  credential: AgentCredential;
  agent: AgentIdentity;
}

/** The permissions a credential's scopes expand to. */
export type CredentialPermissions = readonly Permission[];

/** Whether an agent is active (not disabled). */
export function isAgentActive(agent: AgentIdentity): boolean {
  return agent.disabledAt === null;
}

/**
 * Whether a credential is currently usable, given its agent's status.
 *
 * Revoked, expired and disabled-agent are all "not usable", and all three are
 * checked on every authentication, so revocation and disabling take effect on
 * the very next request with no cache and no restart.
 */
export function isCredentialUsable(
  credential: AgentCredential,
  agent: AgentIdentity,
  at: Date,
): boolean {
  if (!isAgentActive(agent)) return false;
  if (credential.revokedAt !== null) return false;
  if (
    credential.expiresAt !== null &&
    credential.expiresAt.getTime() <= at.getTime()
  ) {
    return false;
  }
  return true;
}

/** The status a credential listing shows. */
export type CredentialStatus = "active" | "revoked" | "expired" | "disabled";

/** Classify a credential for display and for tests. */
export function credentialStatus(
  credential: AgentCredential,
  agent: AgentIdentity,
  at: Date,
): CredentialStatus {
  if (credential.revokedAt !== null) return "revoked";
  if (
    credential.expiresAt !== null &&
    credential.expiresAt.getTime() <= at.getTime()
  ) {
    return "expired";
  }
  if (!isAgentActive(agent)) return "disabled";
  return "active";
}
