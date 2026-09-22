/**
 * The user repository (ADR-040).
 *
 * Identity mapping is the whole job: an OIDC provider asserts `(issuer,
 * subject)` and this repository answers which internal user that is, creating
 * one on first sight. Email is stored for display and refreshed on every login,
 * but it is never used to find a user — an address can be changed or reissued by
 * a provider, so matching on it would let one person's login resolve to
 * another's account.
 *
 * The unique constraint on `(identity_issuer, identity_subject)` is the real
 * arbiter: two concurrent first logins for the same identity race, and the
 * loser's insert fails, which is why `findOrCreateByExternalIdentity` retries
 * with a lookup instead of trusting its own read.
 */
import type { AccountStatus, ExternalIdentity, User } from "../domain/user/user";
import type { SqlClient } from "./sql-client";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";
import { toUser } from "./rows";

export interface UserRepository {
  /** Find a user by internal id. */
  findById(id: string): Promise<User | null>;

  /** Find a user by the identity a provider asserts. */
  findByIdentity(issuer: string, subject: string): Promise<User | null>;

  /**
   * Map an external identity onto an internal user, creating one on first login
   * and refreshing its display name and email afterwards.
   */
  findOrCreateByExternalIdentity(identity: ExternalIdentity): Promise<User>;

  /** Update the display name and email from the provider. */
  refreshProfile(
    id: string,
    profile: { displayName: string; email: string | null },
  ): Promise<User>;

  list(): Promise<User[]>;
  setStatus(id: string, status: AccountStatus): Promise<User>;
}

export interface UserRepositoryOptions {
  /** Injectable so a test gets deterministic ids. */
  newId?: IdGenerator;
}

/** The repository over a `SqlClient`. */
export function createUserRepository(
  client: SqlClient,
  options: UserRepositoryOptions = {},
): UserRepository {
  const newId = options.newId ?? createIdGenerator();

  const findByIdentity = async (
    issuer: string,
    subject: string,
  ): Promise<User | null> => {
    const result = await client.query(
      "SELECT * FROM users WHERE identity_issuer = $1 AND identity_subject = $2",
      [issuer, subject],
    );
    const row = result.rows[0];
    return row ? toUser(row) : null;
  };

  return {
    async findById(id) {
      const result = await client.query("SELECT * FROM users WHERE id = $1", [
        id,
      ]);
      const row = result.rows[0];
      return row ? toUser(row) : null;
    },

    findByIdentity,

    async findOrCreateByExternalIdentity(identity) {
      const existing = await findByIdentity(identity.issuer, identity.subject);
      if (existing) {
        const unchanged =
          existing.displayName === identity.displayName &&
          existing.email === identity.email;
        return unchanged
          ? existing
          : this.refreshProfile(existing.id, {
              displayName: identity.displayName,
              email: identity.email,
            });
      }

      try {
        const result = await client.query(
          `INSERT INTO users (id, identity_issuer, identity_subject, display_name, email)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [
            newId(),
            identity.issuer,
            identity.subject,
            identity.displayName,
            identity.email,
          ],
        );
        return toUser(result.rows[0]);
      } catch (error) {
        // A concurrent first login won the race. The identity is now present, so
        // the caller's intent is satisfied by reading it back.
        const winner = await findByIdentity(identity.issuer, identity.subject);
        if (winner) return winner;
        throw error;
      }
    },

    async refreshProfile(id, profile) {
      const result = await client.query(
        `UPDATE users
            SET display_name = $2, email = $3, updated_at = now()
          WHERE id = $1
      RETURNING *`,
        [id, profile.displayName, profile.email],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`No user with id ${id}.`);
      return toUser(row);
    },

    async list() {
      const result = await client.query(
        "SELECT * FROM users ORDER BY created_at ASC, id ASC",
      );
      return result.rows.map(toUser);
    },

    async setStatus(id, status) {
      const result = await client.query(
        "UPDATE users SET status = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [id, status],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`No user with id ${id}.`);
      return toUser(row);
    },
  };
}
