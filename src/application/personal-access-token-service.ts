/**
 * The Personal Access Token lifecycle (Phase 5).
 *
 * This is the application service behind the browser's token screen. It is the
 * one place a PAT is created, renamed or revoked, and it exists so those rules
 * are not spread across a controller and a React component:
 *
 * - **A token belongs to exactly one user, and only that user can see it.**
 *   Every operation passes the principal's own id into the repository, so a
 *   guessed token id addresses nothing.
 * - **The plaintext exists once.** `create` returns it in its result; the
 *   stored record never contains it. Nothing else in this module can produce a
 *   secret.
 * - **A PAT may not manage PATs.** Management requires a browser session
 *   (`authType: "session"`), so a leaked machine credential cannot mint itself a
 *   longer-lived replacement or quietly revoke the evidence.
 * - **Scopes are validated against the closed vocabulary**, so a token can never
 *   be stored carrying a grant this build does not understand.
 *
 * The service is transport-neutral: the HTTP routes translate an
 * {@link ApplicationError} into a status, and the tests call it directly.
 */
import type { ApplicationContext } from "./context";
import { forbidden, invalid, notFound, unauthorized } from "./errors";
import type {
  PersonalAccessTokenRecord,
  PersonalAccessTokenRepository,
} from "./ports/personal-access-token-repository";
import type { AuditAction, AuditRepository } from "./ports/audit-repository";
import type { ProjectRepository } from "./ports/project-repository";
import { isPatScope, PAT_SCOPES } from "../domain/access/permissions";
import type { PatScope } from "../domain/access/permissions";

/** The longest display name a token may carry. */
export const MAX_TOKEN_NAME_LENGTH = 100;

/**
 * A freshly minted token.
 *
 * The host supplies this factory because generating and hashing secrets is a
 * platform concern (`node:crypto`), and the application layer must stay runnable
 * in a browser test. The service never learns how the secret was made — only
 * that `token` is the value to show once and `tokenHash` is what to store.
 */
export interface MintedToken {
  /** The full `sdm_pat_…` value. Shown once, never persisted by this service. */
  token: string;
  /** The non-secret public prefix, unique across tokens. */
  prefix: string;
  /** A hex digest of {@link token}. */
  tokenHash: string;
}

/** Options for the lifecycle service. */
export interface PersonalAccessTokenServiceOptions {
  tokens: PersonalAccessTokenRepository;
  /** Used to prove a project restriction names a project the user can see. */
  projects: ProjectRepository;
  /** Mints the secret material. Injected by the host. */
  mint: () => MintedToken;
  audit?: AuditRepository;
  /** How long a token may live when the caller asks for no expiry. */
  now?: () => Date;
  onAuditFailure?: (error: unknown, action: AuditAction) => void;
}

/** What `create` accepts. */
export interface CreateTokenInput {
  name: string;
  scopes: readonly string[];
  /** A future instant, or `null`/absent for a token that does not expire. */
  expiresAt?: Date | null;
  /** Optional project restriction; every id must be one the user can see. */
  projectIds?: readonly string[] | null;
}

/** The one moment a plaintext token is available. */
export interface CreatedToken {
  record: PersonalAccessTokenRecord;
  /** The full token value. Returned once, and never again. */
  token: string;
}

export interface PersonalAccessTokenService {
  /** The caller's own tokens, newest first. */
  list(context: ApplicationContext): Promise<PersonalAccessTokenRecord[]>;

  /** Mint a token and return its record plus the one-time plaintext. */
  create(
    context: ApplicationContext,
    input: CreateTokenInput,
  ): Promise<CreatedToken>;

  /** Change a token's display name. */
  rename(
    context: ApplicationContext,
    tokenId: string,
    name: string,
  ): Promise<PersonalAccessTokenRecord>;

  /** Revoke a token. Idempotent from the caller's point of view. */
  revoke(context: ApplicationContext, tokenId: string): Promise<void>;
}

/** The default audit-failure reporter: one line on stderr. */
function reportAuditFailure(error: unknown, action: AuditAction): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`audit ${action} failed: ${message}\n`);
}

/**
 * A management request must come from a human session, not a machine token.
 *
 * Both `pat` and `oauth` credentials are machine credentials; only a browser
 * session may create, rename or revoke one.
 */
function requireSessionPrincipal(context: ApplicationContext): void {
  if (context.principal.userId === "anonymous") {
    throw unauthorized("Sign in to manage access tokens.");
  }
  if (context.principal.authType !== "session") {
    throw forbidden(
      "Access tokens can only be managed from a signed-in browser session.",
    );
  }
}

/** Validate and normalise the requested scopes. */
function normalizeScopes(scopes: readonly string[]): PatScope[] {
  const wanted: PatScope[] = [];
  for (const scope of scopes) {
    if (!isPatScope(scope)) {
      throw invalid(
        `Unknown token scope ${JSON.stringify(scope)}. Choose from: ${PAT_SCOPES.join(", ")}.`,
      );
    }
    if (!wanted.includes(scope)) wanted.push(scope);
  }
  if (wanted.length === 0) {
    throw invalid("At least one token scope is required.");
  }
  return wanted;
}

/** Validate and normalise a token display name. */
function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw invalid("A token name is required.");
  if (trimmed.length > MAX_TOKEN_NAME_LENGTH) {
    throw invalid(
      `A token name may be at most ${MAX_TOKEN_NAME_LENGTH} characters.`,
    );
  }
  return trimmed;
}

/** Build the lifecycle service. */
export function createPersonalAccessTokenService(
  options: PersonalAccessTokenServiceOptions,
): PersonalAccessTokenService {
  const { tokens, projects, mint } = options;
  const now = options.now ?? (() => new Date());

  const writeAudit = async (
    context: ApplicationContext,
    action: AuditAction,
    record: PersonalAccessTokenRecord,
  ): Promise<void> => {
    if (!options.audit) return;
    try {
      await options.audit.record({
        action,
        userId: context.principal.userId,
        authType: context.principal.authType,
        requestId: context.requestId,
        detail: {
          tokenId: record.id,
          name: record.name,
          scopes: [...record.scopes],
        },
      });
    } catch (error) {
      (options.onAuditFailure ?? reportAuditFailure)(error, action);
    }
  };

  /** Resolve a token that belongs to the caller, or report it as missing. */
  const ownToken = async (
    context: ApplicationContext,
    tokenId: string,
  ): Promise<PersonalAccessTokenRecord> => {
    const record = await tokens.findByIdForUser(
      context.principal.userId,
      tokenId,
    );
    // Someone else's token is answered exactly as one that does not exist: a
    // token id must not be an existence oracle across users.
    if (!record) throw notFound(`No access token with id ${tokenId}.`);
    return record;
  };

  return {
    async list(context) {
      requireSessionPrincipal(context);
      return tokens.listForUser(context.principal.userId);
    },

    async create(context, input) {
      requireSessionPrincipal(context);
      const name = normalizeName(input.name);
      const scopes = normalizeScopes(input.scopes);

      let projectIds: string[] | null = null;
      if (input.projectIds !== undefined && input.projectIds !== null) {
        const unique: string[] = [];
        for (const projectId of input.projectIds) {
          if (unique.includes(projectId)) continue;
          const role = await projects.roleOf(
            projectId,
            context.principal.userId,
          );
          if (role === null) {
            // The same answer a restricted credential gets: a project the user
            // cannot see does not exist.
            throw notFound(`No project with id ${projectId}.`);
          }
          unique.push(projectId);
        }
        projectIds = unique.length === 0 ? null : unique;
      }

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
      const record = await tokens.create({
        userId: context.principal.userId,
        name,
        prefix: minted.prefix,
        tokenHash: minted.tokenHash,
        scopes,
        projectIds,
        expiresAt,
      });
      await writeAudit(context, "token.created", record);
      // The plaintext is handed back exactly here and nowhere else.
      return { record, token: minted.token };
    },

    async rename(context, tokenId, name) {
      requireSessionPrincipal(context);
      const normalized = normalizeName(name);
      await ownToken(context, tokenId);
      const updated = await tokens.rename(
        context.principal.userId,
        tokenId,
        normalized,
      );
      if (!updated) throw notFound(`No access token with id ${tokenId}.`);
      await writeAudit(context, "token.renamed", updated);
      return updated;
    },

    async revoke(context, tokenId) {
      requireSessionPrincipal(context);
      // Revoking a token that is already gone (or not the caller's) is a no-op
      // rather than an error: the caller's intent — "it must not work" — holds
      // either way, and a retry is harmless.
      const record = await ownToken(context, tokenId);
      const changed = await tokens.revoke(context.principal.userId, tokenId);
      if (changed) await writeAudit(context, "token.revoked", record);
    },
  };
}

/** Whether a record is currently usable (not revoked, not expired). */
export function isTokenUsable(
  record: PersonalAccessTokenRecord,
  at: Date,
): boolean {
  if (record.revokedAt !== null) return false;
  if (record.expiresAt !== null && record.expiresAt.getTime() <= at.getTime()) {
    return false;
  }
  return true;
}
