/**
 * The agent lifecycle: identities and their credentials (ADR-043).
 *
 * This is the application service behind the settings screen and the API. It is
 * the one place an agent or credential is created, renamed, disabled, revoked
 * or rotated, so those rules do not live in a controller or a React component:
 *
 * - **Ownership is the subject user's.** Every operation passes the caller's
 *   user id into the repository, so a guessed agent or credential id addresses
 *   nothing, and someone else's id answers exactly as a missing one.
 * - **A credential is a machine credential, not a session.** Management requires
 *   a browser session *and* the `agent:manage`/`credential:manage` capability,
 *   so a credential cannot mint or revoke credentials — even one that somehow
 *   carried those scopes is still refused by the session check.
 * - **The plaintext exists once.** `createCredential` and `rotateCredential`
 *   return it; nothing else in the module can produce one, and the stored
 *   record never contains it.
 * - **A restriction only narrows.** A credential's allowed projects are
 *   validated against the *owner's* live membership, so a credential can never
 *   name a project its user cannot see.
 */
import type { ApplicationContext } from "./context";
import { actorIdOf, actorTypeOf, credentialIdOf } from "./context";
import { forbidden, invalid, notFound, unauthorized } from "./errors";
import type {
  AgentIdentityRepository,
  AgentCredentialRepository,
} from "./ports/agent-repository";
import type { AuditAction, AuditRepository } from "./ports/audit-repository";
import type { ProjectRepository } from "./ports/project-repository";
import type { AgentCredential, AgentIdentity } from "../domain/agent/agent";
import {
  credentialStatus,
  isCredentialUsable,
  type CredentialStatus,
} from "../domain/agent/agent";
import {
  isCredentialScope,
  type CredentialScope,
} from "../domain/access/permissions";
import type { JsonObject } from "../shared/json/json-value";
import { credentialGrants } from "./authorization";

/** The longest an agent or credential name may be. */
export const MAX_AGENT_NAME_LENGTH = 100;
/** The longest an agent description may be. */
export const MAX_AGENT_DESCRIPTION_LENGTH = 500;

/**
 * A freshly minted credential's secret material.
 *
 * The host supplies this factory because generating and hashing secrets is a
 * platform concern (`node:crypto`), and the application layer must stay runnable
 * in a browser test. The service never learns how the secret was made.
 */
export interface MintedCredential {
  /** The full `sdm_pat_…` value. Shown once, never persisted by this service. */
  token: string;
  /** The non-secret public prefix, unique across credentials. */
  publicPrefix: string;
  /** A hex digest of {@link token}. */
  secretHash: string;
}

/** An agent with the counts a listing shows. */
export interface AgentSummary {
  agent: AgentIdentity;
  credentialCount: number;
  activeCredentialCount: number;
}

/** A credential as a listing shows it: metadata plus its computed status. */
export interface CredentialSummary {
  credential: AgentCredential;
  status: CredentialStatus;
}

/** The one moment a plaintext credential is available. */
export interface CreatedAgentCredential {
  credential: AgentCredential;
  /** The full token value. Returned once, and never again. */
  token: string;
}

/** What `createCredential` accepts. */
export interface CreateCredentialInput {
  name: string;
  scopes: readonly string[];
  /** A future instant, or `null`/absent for a credential that does not expire. */
  expiresAt?: Date | null;
  /** Optional project restriction; every id must be one the user can see. */
  allowedProjectIds?: readonly string[] | null;
}

/** What `renameAgent` accepts. */
export interface RenameAgentInput {
  name?: string;
  description?: string | null;
}

/** Options for the agent service. */
export interface AgentServiceOptions {
  agents: AgentIdentityRepository;
  credentials: AgentCredentialRepository;
  /** Used to prove a project restriction names a project the user can see. */
  projects: ProjectRepository;
  /** Mints the secret material. Injected by the host. */
  mint: () => MintedCredential;
  audit?: AuditRepository;
  now?: () => Date;
  onAuditFailure?: (error: unknown, action: AuditAction) => void;
}

export interface AgentService {
  listAgents(context: ApplicationContext): Promise<AgentSummary[]>;
  createAgent(
    context: ApplicationContext,
    input: { name: string; description?: string | null },
  ): Promise<AgentIdentity>;
  renameAgent(
    context: ApplicationContext,
    agentId: string,
    changes: RenameAgentInput,
  ): Promise<AgentIdentity>;
  /** Disable (or re-enable) an agent. Disabling invalidates every credential. */
  setAgentDisabled(
    context: ApplicationContext,
    agentId: string,
    disabled: boolean,
  ): Promise<AgentIdentity>;
  listCredentials(
    context: ApplicationContext,
    agentId: string,
  ): Promise<CredentialSummary[]>;
  createCredential(
    context: ApplicationContext,
    agentId: string,
    input: CreateCredentialInput,
  ): Promise<CreatedAgentCredential>;
  revokeCredential(
    context: ApplicationContext,
    agentId: string,
    credentialId: string,
  ): Promise<void>;
  rotateCredential(
    context: ApplicationContext,
    agentId: string,
    credentialId: string,
  ): Promise<CreatedAgentCredential>;
}

/** The default audit-failure reporter: one line on stderr. */
function reportAuditFailure(error: unknown, action: AuditAction): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`audit ${action} failed: ${message}\n`);
}

/**
 * Management requires a human session.
 *
 * A credential — even one explicitly granted a management scope — cannot manage
 * agents or credentials. This is the "an agent cannot mint another agent" rule
 * at its most direct, and it is independent of any scope check.
 */
function requireSessionPrincipal(context: ApplicationContext): void {
  if (context.principal.subjectUserId === "anonymous") {
    throw unauthorized("Sign in to manage agents and access tokens.");
  }
  if (context.principal.authType !== "session") {
    throw forbidden(
      "Agents and access tokens can only be managed from a signed-in browser session.",
    );
  }
}

/** Require a capability on the credential, on top of the session check. */
function requireCapability(
  context: ApplicationContext,
  permission: "agent:manage" | "credential:manage",
): void {
  if (!credentialGrants(context.principal, permission)) {
    throw forbidden(`This credential does not carry ${permission}.`);
  }
}

/** Validate and normalise an agent or credential name. */
function normalizeName(name: string, what: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw invalid(`A ${what} name is required.`);
  if (trimmed.length > MAX_AGENT_NAME_LENGTH) {
    throw invalid(
      `A ${what} name may be at most ${MAX_AGENT_NAME_LENGTH} characters.`,
    );
  }
  return trimmed;
}

/** Validate and normalise an optional description. */
function normalizeDescription(
  description: string | null | undefined,
): string | null {
  if (description === undefined || description === null) return null;
  const trimmed = description.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_AGENT_DESCRIPTION_LENGTH) {
    throw invalid(
      `A description may be at most ${MAX_AGENT_DESCRIPTION_LENGTH} characters.`,
    );
  }
  return trimmed;
}

/** Validate and normalise the requested credential scopes. */
function normalizeScopes(scopes: readonly string[]): CredentialScope[] {
  const wanted: CredentialScope[] = [];
  for (const scope of scopes) {
    if (!isCredentialScope(scope)) {
      throw invalid(`Unknown credential scope ${JSON.stringify(scope)}.`);
    }
    if (!wanted.includes(scope)) wanted.push(scope);
  }
  if (wanted.length === 0) {
    throw invalid("At least one credential scope is required.");
  }
  return wanted;
}

/** Build the agent service. */
export function createAgentService(options: AgentServiceOptions): AgentService {
  const { agents, credentials, projects, mint } = options;
  const now = options.now ?? (() => new Date());

  const writeAudit = async (
    context: ApplicationContext,
    action: AuditAction,
    detail: JsonObject,
  ): Promise<void> => {
    if (!options.audit) return;
    try {
      await options.audit.record({
        action,
        subjectUserId: context.principal.subjectUserId,
        actorType: actorTypeOf(context.principal),
        actorId: actorIdOf(context.principal),
        credentialId: credentialIdOf(context.principal),
        authType: context.principal.authType,
        requestId: context.requestId,
        detail,
      });
    } catch (error) {
      (options.onAuditFailure ?? reportAuditFailure)(error, action);
    }
  };

  /** Resolve an agent the caller owns, or report it as missing. */
  const ownAgent = async (
    context: ApplicationContext,
    agentId: string,
  ): Promise<AgentIdentity> => {
    const agent = await agents.findByIdForUser(
      context.principal.subjectUserId,
      agentId,
    );
    // Someone else's agent is answered exactly as one that does not exist.
    if (!agent) throw notFound(`No agent with id ${agentId}.`);
    return agent;
  };

  /** Resolve a credential the caller owns, or report it as missing. */
  const ownCredential = async (
    context: ApplicationContext,
    agentId: string,
    credentialId: string,
  ): Promise<{ credential: AgentCredential; agent: AgentIdentity }> => {
    const found = await credentials.findByIdForUser(
      context.principal.subjectUserId,
      credentialId,
    );
    if (!found || found.credential.agentId !== agentId) {
      throw notFound(`No credential with id ${credentialId}.`);
    }
    return found;
  };

  /** Validate a project restriction against the caller's live membership. */
  const normalizeProjectIds = async (
    context: ApplicationContext,
    wanted: readonly string[] | null | undefined,
  ): Promise<string[] | null> => {
    if (wanted === undefined || wanted === null) return null;
    const unique: string[] = [];
    for (const projectId of wanted) {
      if (unique.includes(projectId)) continue;
      const role = await projects.roleOf(
        projectId,
        context.principal.subjectUserId,
      );
      if (role === null) {
        // The same answer a restricted credential gets: a project the user
        // cannot see does not exist.
        throw notFound(`No project with id ${projectId}.`);
      }
      unique.push(projectId);
    }
    return unique.length === 0 ? null : unique;
  };

  return {
    async listAgents(context) {
      requireSessionPrincipal(context);
      requireCapability(context, "agent:manage");
      const owned = await agents.listForUser(context.principal.subjectUserId);
      const summaries: AgentSummary[] = [];
      for (const agent of owned) {
        const all = await credentials.listForAgent(agent.id);
        summaries.push({
          agent,
          credentialCount: all.length,
          activeCredentialCount: all.filter((credential) =>
            isCredentialUsable(credential, agent, now()),
          ).length,
        });
      }
      return summaries;
    },

    async createAgent(context, input) {
      requireSessionPrincipal(context);
      requireCapability(context, "agent:manage");
      const name = normalizeName(input.name, "agent");
      const description = normalizeDescription(input.description);
      const agent = await agents.create({
        ownerUserId: context.principal.subjectUserId,
        name,
        description,
      });
      await writeAudit(context, "agent.created", {
        agentId: agent.id,
        name: agent.name,
      });
      return agent;
    },

    async renameAgent(context, agentId, changes) {
      requireSessionPrincipal(context);
      requireCapability(context, "agent:manage");
      await ownAgent(context, agentId);
      const update: { name?: string; description?: string | null } = {};
      if (changes.name !== undefined) {
        update.name = normalizeName(changes.name, "agent");
      }
      if (changes.description !== undefined) {
        update.description = normalizeDescription(changes.description);
      }
      const updated = await agents.update(
        context.principal.subjectUserId,
        agentId,
        update,
      );
      if (!updated) throw notFound(`No agent with id ${agentId}.`);
      await writeAudit(context, "agent.updated", { agentId: updated.id });
      return updated;
    },

    async setAgentDisabled(context, agentId, disabled) {
      requireSessionPrincipal(context);
      requireCapability(context, "agent:manage");
      await ownAgent(context, agentId);
      const updated = await agents.setDisabled(
        context.principal.subjectUserId,
        agentId,
        disabled,
      );
      if (!updated) throw notFound(`No agent with id ${agentId}.`);
      await writeAudit(context, disabled ? "agent.disabled" : "agent.updated", {
        agentId: updated.id,
        disabled,
      });
      return updated;
    },

    async listCredentials(context, agentId) {
      requireSessionPrincipal(context);
      requireCapability(context, "credential:manage");
      const agent = await ownAgent(context, agentId);
      const all = await credentials.listForAgent(agent.id);
      const at = now();
      return all.map((credential) => ({
        credential,
        status: credentialStatus(credential, agent, at),
      }));
    },

    async createCredential(context, agentId, input) {
      requireSessionPrincipal(context);
      requireCapability(context, "credential:manage");
      const agent = await ownAgent(context, agentId);
      const name = normalizeName(input.name, "credential");
      const scopes = normalizeScopes(input.scopes);
      const allowedProjectIds = await normalizeProjectIds(
        context,
        input.allowedProjectIds,
      );

      const expiresAt = input.expiresAt ?? null;
      if (expiresAt !== null) {
        if (Number.isNaN(expiresAt.getTime())) {
          throw invalid("expiresAt must be a valid timestamp.");
        }
        if (expiresAt.getTime() <= now().getTime()) {
          throw invalid("expiresAt must be in the future.");
        }
      }

      const minted = mint();
      const credential = await credentials.create({
        agentId: agent.id,
        name,
        publicPrefix: minted.publicPrefix,
        secretHash: minted.secretHash,
        scopes,
        allowedProjectIds,
        expiresAt,
      });
      await writeAudit(context, "credential.created", {
        agentId: agent.id,
        credentialId: credential.id,
        scopes: [...credential.scopes],
      });
      // The plaintext is handed back exactly here and nowhere else.
      return { credential, token: minted.token };
    },

    async revokeCredential(context, agentId, credentialId) {
      requireSessionPrincipal(context);
      requireCapability(context, "credential:manage");
      await ownAgent(context, agentId);
      const found = await ownCredential(context, agentId, credentialId);
      const changed = await credentials.revoke(agentId, credentialId);
      if (changed) {
        await writeAudit(context, "credential.revoked", {
          agentId,
          credentialId: found.credential.id,
        });
      }
    },

    async rotateCredential(context, agentId, credentialId) {
      requireSessionPrincipal(context);
      requireCapability(context, "credential:manage");
      const agent = await ownAgent(context, agentId);
      const found = await ownCredential(context, agentId, credentialId);
      // A credential that is already revoked is not rotated: a second rotate
      // would mint a second live secret, so this is refused deterministically
      // instead. An expired credential may be rotated — that is the renewal
      // case.
      if (found.credential.revokedAt !== null) {
        throw invalid(
          "This credential is already revoked; create a new one instead of rotating it.",
        );
      }

      // Rotation is create-new-then-revoke-old. If minting fails, nothing
      // changes; if the revoke fails the new credential is already returned and
      // the old one is still separately revocable, so the failure leaves two
      // live credentials rather than none. That is the fail-open direction only
      // for a moment and only toward the owner; it is documented in ADR-043.
      const at = now();
      const expiresAt =
        found.credential.expiresAt !== null &&
        found.credential.expiresAt.getTime() > at.getTime()
          ? found.credential.expiresAt
          : new Date(at.getTime() + 90 * 24 * 60 * 60 * 1000);

      const minted = mint();
      const credential = await credentials.create({
        agentId: agent.id,
        name: found.credential.name,
        publicPrefix: minted.publicPrefix,
        secretHash: minted.secretHash,
        scopes: found.credential.scopes,
        allowedProjectIds: found.credential.allowedProjectIds,
        expiresAt,
      });
      const revoked = await credentials.revoke(agentId, credentialId);
      await writeAudit(context, "credential.rotated", {
        agentId: agent.id,
        credentialId: credential.id,
        replacedCredentialId: credentialId,
        revokedOld: revoked,
      });
      return { credential, token: minted.token };
    },
  };
}
