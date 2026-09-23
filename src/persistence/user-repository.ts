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
 * The unique constraint on `user_identities.(issuer, subject)` is the real
 * arbiter: two concurrent first logins for the same identity race, and the
 * loser's insert fails, which is why `findOrCreateByExternalIdentity` retries
 * with a lookup instead of trusting its own read.
 */
import type {
  AccountStatus,
  ExternalIdentity,
  User,
} from "../domain/user/user";
import type { SqlClient } from "./sql-client";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";
import { toUser } from "./rows";

export interface UserRepository {
  /** Find a user by internal id. */
  findById(id: string): Promise<User | null>;

  /** Find a user by the identity a provider asserts. */
  findByIdentity(issuer: string, subject: string): Promise<User | null>;

  /** Find a local account and its password verifier by normalized email. */
  findLocalByEmail(email: string): Promise<LocalLoginRecord | null>;

  /** Create a pending local account, credential, and default workspace atomically. */
  createLocalAccount(input: {
    email: string;
    displayName: string;
    passwordSalt: string;
    passwordHash: string;
  }): Promise<User>;

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
  setStatus(
    id: string,
    status: AccountStatus,
    activatedBy?: string | null,
  ): Promise<User>;
}

export interface LocalLoginRecord {
  user: User;
  passwordSalt: string;
  passwordHash: string;
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
      `SELECT u.* FROM users u
         JOIN user_identities i ON i.user_id = u.id
        WHERE i.issuer = $1 AND i.subject = $2`,
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

    async findLocalByEmail(email) {
      const result = await client.query(
        `SELECT u.*, c.password_salt, c.password_hash
           FROM users u
           JOIN local_credentials c ON c.user_id = u.id
          WHERE c.email = $1`,
        [email],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        user: toUser(row),
        passwordSalt: String(row.password_salt),
        passwordHash: String(row.password_hash),
      };
    },

    async createLocalAccount(input) {
      const id = newId();
      const result = await client.transaction(async (tx) => {
        const inserted = await tx.query(
          `INSERT INTO users (id, display_name, email, status)
           VALUES ($1, $2, $3, 'PENDING')
           RETURNING *`,
          [id, input.displayName, input.email],
        );
        await tx.query(
          `INSERT INTO workspaces (id, owner_id, name, is_default) VALUES ($1, $1, $2, true)`,
          [id, `${input.displayName} Workspace`],
        );
        await tx.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role)
           VALUES ($1, $1, 'ADMIN')`,
          [id],
        );
        await tx.query(
          `INSERT INTO local_credentials
             (user_id, email, password_salt, password_hash)
           VALUES ($1, $2, $3, $4)`,
          [id, input.email, input.passwordSalt, input.passwordHash],
        );
        return inserted;
      });
      return toUser(result.rows[0]);
    },

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
        const id = newId();
        const result = await client.transaction(async (tx) => {
          const inserted = await tx.query(
            `INSERT INTO users (id, display_name, email)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [id, identity.displayName, identity.email],
          );
          await tx.query(
            `INSERT INTO user_identities (user_id, issuer, subject)
             VALUES ($1, $2, $3)`,
            [id, identity.issuer, identity.subject],
          );
          await tx.query(
            `INSERT INTO workspaces (id, owner_id, name, is_default)
              VALUES ($1, $1, $2, true)`,
            [id, `${identity.displayName || "Personal"} Workspace`],
          );
          await tx.query(
            `INSERT INTO workspace_members (workspace_id, user_id, role)
             VALUES ($1, $1, 'ADMIN')`,
            [id],
          );
          return inserted;
        });
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

    async setStatus(id, status, activatedBy = null) {
      const result = await client.query(
        `UPDATE users
            SET status = $2,
                activated_at = CASE WHEN $2 = 'ACTIVE' THEN now() ELSE activated_at END,
                activated_by = CASE WHEN $2 = 'ACTIVE' THEN $3 ELSE activated_by END,
                updated_at = now()
          WHERE id = $1
      RETURNING *`,
        [id, status, activatedBy],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`No user with id ${id}.`);
      return toUser(row);
    },
  };
}
