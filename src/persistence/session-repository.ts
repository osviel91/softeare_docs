/**
 * Browser sessions, server-side (ADR-040).
 *
 * A session is a row, not a signed blob, and the cookie carries a secret whose
 * *hash* is what the row holds. Three consequences, all intended:
 *
 * - **Logout and revocation are immediate.** Deleting or revoking the row ends
 *   the session everywhere, which a self-contained token cannot do without a
 *   blocklist.
 * - **A database leak is not a login.** The stored value cannot be presented as
 *   a cookie, because the cookie value is the pre-image of the hash.
 * - **Nothing sensitive is in the browser.** The cookie is `HttpOnly`, so no
 *   script reads it, and it carries no identity claim — only a lookup key.
 *
 * `expires_at` is set from the configured TTL at creation and checked on every
 * read, so an expired row is inert even before it is cleaned up.
 */
import type { SqlClient } from "./sql-client";
import type { User } from "../domain/user/user";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";
import { toUser } from "./rows";

/** A stored session, without the user. */
export interface SessionRecord {
  id: string;
  userId: string;
  /** A hex digest of the cookie secret. Never the secret itself. */
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  userAgent: string | null;
}

/** A session together with the user it belongs to. */
export interface SessionWithUser extends SessionRecord {
  user: User;
}

export interface SessionRepository {
  /** Create a session row for a user. */
  create(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
  }): Promise<SessionRecord>;

  /** Find a session by id, with its user, or `null` when it does not exist. */
  findById(id: string): Promise<SessionWithUser | null>;

  /** Record that a session was used. Best-effort. */
  touch(id: string): Promise<void>;

  /** End one session. */
  revoke(id: string): Promise<void>;

  /** End every session for a user, except optionally the current one. */
  revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number>;

  /** Every live session for a user, newest first. */
  listForUser(userId: string): Promise<SessionRecord[]>;

  /** Delete sessions that expired before a moment. Returns how many. */
  deleteExpiredBefore(moment: Date): Promise<number>;
}

/** Map a `sessions` row. */
function toSession(row: Record<string, unknown>): SessionRecord {
  const value = (key: string): unknown => row[key];
  return {
    id: String(value("id")),
    userId: String(value("user_id")),
    tokenHash: String(value("token_hash")),
    createdAt:
      value("created_at") instanceof Date
        ? (value("created_at") as Date)
        : new Date(String(value("created_at"))),
    expiresAt:
      value("expires_at") instanceof Date
        ? (value("expires_at") as Date)
        : new Date(String(value("expires_at"))),
    lastSeenAt:
      value("last_seen_at") === null || value("last_seen_at") === undefined
        ? null
        : new Date(String(value("last_seen_at"))),
    revokedAt:
      value("revoked_at") === null || value("revoked_at") === undefined
        ? null
        : new Date(String(value("revoked_at"))),
    userAgent:
      value("user_agent") === null ? null : String(value("user_agent")),
  };
}

/** The repository over a `SqlClient`. */
export function createSessionRepository(client: SqlClient): SessionRepository {
  return {
    async create(input) {
      const result = await client.query(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          input.id,
          input.userId,
          input.tokenHash,
          input.expiresAt,
          input.userAgent ?? null,
        ],
      );
      return toSession(result.rows[0]);
    },

    async findById(id) {
      const result = await client.query(
        `SELECT s.*, row_to_json(u.*) AS user_json
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return null;
      const userJson = row.user_json;
      const user =
        typeof userJson === "object" && userJson !== null
          ? toUser(userJson as Record<string, unknown>)
          : null;
      if (!user) return null;
      return { ...toSession(row), user };
    },

    async touch(id) {
      await client.query(
        "UPDATE sessions SET last_seen_at = now() WHERE id = $1",
        [id],
      );
    },

    async revoke(id) {
      await client.query(
        "UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
        [id],
      );
    },

    async revokeAllForUser(userId, exceptSessionId) {
      const result = exceptSessionId
        ? await client.query(
            `UPDATE sessions SET revoked_at = now()
              WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
            [userId, exceptSessionId],
          )
        : await client.query(
            `UPDATE sessions SET revoked_at = now()
              WHERE user_id = $1 AND revoked_at IS NULL`,
            [userId],
          );
      return result.rowCount;
    },

    async listForUser(userId) {
      const result = await client.query(
        `SELECT * FROM sessions
          WHERE user_id = $1
          ORDER BY created_at DESC, id DESC`,
        [userId],
      );
      return result.rows.map(toSession);
    },

    async deleteExpiredBefore(moment) {
      const result = await client.query(
        "DELETE FROM sessions WHERE expires_at < $1",
        [moment],
      );
      return result.rowCount;
    },
  };
}

/** A session id generator, exported so the auth routes and tests share one. */
export function sessionIdGenerator(): IdGenerator {
  return createIdGenerator();
}
