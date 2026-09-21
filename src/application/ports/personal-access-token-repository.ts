/**
 * The Personal Access Token persistence port (Phase 5).
 *
 * A PAT is a *bearer credential*: whoever presents it is the user, so the row
 * must never be able to be replayed as one. That is why the port stores a
 * {@link PersonalAccessTokenRecord.tokenHash} and not a token, and why the
 * plaintext exists only in the return value of `create` — the one moment it is
 * shown to its owner.
 *
 * Two identifiers, with two different jobs:
 *
 * - `id` is the stable, opaque database id. It is what a revoke or a rename
 *   addresses, and it appears in audit detail.
 * - `prefix` is the non-secret public part of the token, unique by constraint.
 *   It exists so a verification can find the right row with one indexed lookup
 *   instead of scanning every hash.
 *
 * The port lives in the application layer because the lifecycle use cases
 * consume it; `src/persistence` implements it and points back here.
 */
import type { UserId } from "../context";

/** A stored PAT, without the plaintext secret (which is never stored). */
export interface PersonalAccessTokenRecord {
  id: string;
  /** The user who owns the token. A PAT is never shared between users. */
  userId: UserId;
  /** The display name the owner gave it. */
  name: string;
  /** The non-secret public identifier the token carries. Unique. */
  prefix: string;
  /** A hex digest of the full token. Never the token itself. */
  tokenHash: string;
  /** The coarse scopes (`projects:read`, `projects:write`) this token carries. */
  scopes: readonly string[];
  /**
   * The projects this token is restricted to, or `null` for the owner's whole
   * membership. Restriction is a second, independent narrowing: a token scoped
   * to project A is answered as if project B did not exist.
   */
  projectIds: readonly string[] | null;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** What a caller supplies to mint a PAT row. */
export interface NewPersonalAccessToken {
  /** The id to use; omitted means "mint one". */
  id?: string;
  userId: UserId;
  name: string;
  prefix: string;
  tokenHash: string;
  scopes: readonly string[];
  projectIds?: readonly string[] | null;
  expiresAt?: Date | null;
}

export interface PersonalAccessTokenRepository {
  /** Record a new token. The plaintext is a caller's business, not the port's. */
  create(input: NewPersonalAccessToken): Promise<PersonalAccessTokenRecord>;

  /** Find a token by its stable id. Used by the verification path. */
  findById(id: string): Promise<PersonalAccessTokenRecord | null>;

  /**
   * Find a token by its public prefix.
   *
   * This is the lookup the bearer verifier performs first; the candidate's hash
   * is compared in constant time afterwards.
   */
  findByPrefix(prefix: string): Promise<PersonalAccessTokenRecord | null>;

  /** A user's own token, or `null` when it belongs to someone else. */
  findByIdForUser(
    userId: UserId,
    id: string,
  ): Promise<PersonalAccessTokenRecord | null>;

  /** Every token a user owns, newest first. Never exposes a hash to a caller. */
  listForUser(userId: UserId): Promise<PersonalAccessTokenRecord[]>;

  /** Record that a token was presented. Best-effort, like a session touch. */
  touch(id: string): Promise<void>;

  /** Change a token's display name. Returns `null` when it is not the user's. */
  rename(
    userId: UserId,
    id: string,
    name: string,
  ): Promise<PersonalAccessTokenRecord | null>;

  /**
   * Revoke a token.
   *
   * Returns whether a live row was changed, so the lifecycle use case can audit
   * a real revocation rather than a repeated no-op. Ownership is part of the
   * predicate: one user can never revoke another's credential.
   */
  revoke(userId: UserId, id: string): Promise<boolean>;
}
