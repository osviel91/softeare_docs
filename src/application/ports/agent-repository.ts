/**
 * The agent persistence ports (ADR-043, Phase 5).
 *
 * Two ports, mirroring the two entities. An agent identity is the durable
 * automation principal; a credential is one revocable secret belonging to it.
 * Keeping them separate is what allows several credentials per agent and an
 * agent-level disable that invalidates all of them at once.
 *
 * Every method that a user addresses by id takes the **owner's** user id as
 * part of its predicate. That is not decoration: a credential's owner is its
 * agent's owner, and putting the join in the query is what makes "list my
 * agent's credentials" unable to return someone else's even if a controller
 * forgot to check first.
 *
 * The ports live in the application layer; `src/persistence` implements them.
 */
import type {
  AgentCredential,
  AgentCredentialWithAgent,
  AgentIdentity,
} from "../../domain/agent/agent";
import type { CredentialScope } from "../../domain/access/permissions";

/** What a caller supplies to create an agent. */
export interface NewAgentIdentity {
  /** The id to use; omitted means "mint one". */
  id?: string;
  ownerUserId: string;
  name: string;
  description?: string | null;
}

/** The mutable fields of an agent identity. */
export interface AgentIdentityChanges {
  name?: string;
  description?: string | null;
}

export interface AgentIdentityRepository {
  create(input: NewAgentIdentity): Promise<AgentIdentity>;

  findById(id: string): Promise<AgentIdentity | null>;

  /** An agent only if `ownerUserId` owns it; `null` otherwise. */
  findByIdForUser(
    ownerUserId: string,
    id: string,
  ): Promise<AgentIdentity | null>;

  /** A user's agents, newest first. */
  listForUser(ownerUserId: string): Promise<AgentIdentity[]>;

  /** Rename or re-describe an agent the user owns. */
  update(
    ownerUserId: string,
    id: string,
    changes: AgentIdentityChanges,
  ): Promise<AgentIdentity | null>;

  /** Disable or re-enable an agent the user owns. */
  setDisabled(
    ownerUserId: string,
    id: string,
    disabled: boolean,
  ): Promise<AgentIdentity | null>;
}

/** What a caller supplies to mint a credential row. */
export interface NewAgentCredential {
  /** The id to use; omitted means "mint one". */
  id?: string;
  agentId: string;
  name: string;
  /** The non-secret public identifier the token carries. */
  publicPrefix: string;
  /** A hex digest of the full token. */
  secretHash: string;
  scopes: readonly CredentialScope[];
  /** `null`/absent means "no project restriction". */
  allowedProjectIds?: readonly string[] | null;
  expiresAt?: Date | null;
}

export interface AgentCredentialRepository {
  /** Record a credential and its project restriction together. */
  create(input: NewAgentCredential): Promise<AgentCredential>;

  /**
   * Find a credential by its public prefix, with its agent.
   *
   * This is the authentication lookup: one indexed query, no scan of hashes.
   * The agent comes back with it so the disabled check needs no second round
   * trip.
   */
  findByPrefix(publicPrefix: string): Promise<AgentCredentialWithAgent | null>;

  findById(id: string): Promise<AgentCredentialWithAgent | null>;

  /** A credential only if the user owns its agent. */
  findByIdForUser(
    ownerUserId: string,
    credentialId: string,
  ): Promise<AgentCredentialWithAgent | null>;

  /** Every credential of one agent, newest first. */
  listForAgent(agentId: string): Promise<AgentCredential[]>;

  /** How many credentials an agent has, for a listing. */
  countForAgent(agentId: string): Promise<number>;

  /** Record that a credential was presented. Best-effort. */
  touch(id: string): Promise<void>;

  /**
   * Revoke a credential.
   *
   * Scoped to the agent so a credential id from another agent (or another
   * user) addresses nothing. Returns whether a live row changed.
   */
  revoke(agentId: string, credentialId: string): Promise<boolean>;

  /** Replace a credential's project restriction. */
  setAllowedProjects(
    credentialId: string,
    projectIds: readonly string[] | null,
  ): Promise<void>;
}
