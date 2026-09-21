/**
 * Personal Access Tokens over PostgreSQL (Phase 5).
 *
 * The table was created with the initial schema; this module is its repository.
 * It keeps the one invariant the whole design rests on: **the plaintext token is
 * never a column.** What is stored is a SHA-256 digest of the full token plus the
 * non-secret `prefix` the digest is looked up by.
 *
 * Every method that touches a *user's* token takes the user id as part of its
 * predicate. That is not decoration: it is what makes "list my tokens", "rename
 * my token" and "revoke my token" unable to address someone else's row even if a
 * controller forgot to check first.
 */
import type {
  NewPersonalAccessToken,
  PersonalAccessTokenRecord,
  PersonalAccessTokenRepository,
} from "../application/ports/personal-access-token-repository";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";
import { textArray, timestamp, timestampOrNull } from "./rows";
import type { SqlClient, SqlRow } from "./sql-client";

/** Options for the repository. */
export interface PersonalAccessTokenRepositoryOptions {
  /** Injectable so a test gets deterministic ids. */
  newId?: IdGenerator;
}

/** Map a `personal_access_tokens` row onto the port's record. */
export function toPersonalAccessToken(row: SqlRow): PersonalAccessTokenRecord {
  const projectIds = textArray(row, "project_ids");
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    prefix: String(row.prefix),
    tokenHash: String(row.token_hash),
    scopes: textArray(row, "scopes"),
    // An absent or empty restriction means "no narrowing beyond membership".
    // `null` and `[]` are the same claim, so they map to the same value.
    projectIds: projectIds.length === 0 ? null : projectIds,
    createdAt: timestamp(row, "created_at"),
    expiresAt: timestampOrNull(row, "expires_at"),
    lastUsedAt: timestampOrNull(row, "last_used_at"),
    revokedAt: timestampOrNull(row, "revoked_at"),
  };
}

/** The repository over a `SqlClient`. */
export function createPersonalAccessTokenRepository(
  client: SqlClient,
  options: PersonalAccessTokenRepositoryOptions = {},
): PersonalAccessTokenRepository {
  const newId = options.newId ?? createIdGenerator();

  return {
    async create(input: NewPersonalAccessToken) {
      const result = await client.query(
        `INSERT INTO personal_access_tokens
           (id, user_id, name, prefix, token_hash, scopes, project_ids, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          input.id ?? newId(),
          input.userId,
          input.name,
          input.prefix,
          input.tokenHash,
          [...input.scopes],
          input.projectIds === undefined || input.projectIds === null
            ? null
            : [...input.projectIds],
          input.expiresAt ?? null,
        ],
      );
      return toPersonalAccessToken(result.rows[0]);
    },

    async findById(id) {
      const result = await client.query(
        "SELECT * FROM personal_access_tokens WHERE id = $1",
        [id],
      );
      const row = result.rows[0];
      return row ? toPersonalAccessToken(row) : null;
    },

    async findByPrefix(prefix) {
      const result = await client.query(
        "SELECT * FROM personal_access_tokens WHERE prefix = $1",
        [prefix],
      );
      const row = result.rows[0];
      return row ? toPersonalAccessToken(row) : null;
    },

    async findByIdForUser(userId, id) {
      const result = await client.query(
        "SELECT * FROM personal_access_tokens WHERE id = $1 AND user_id = $2",
        [id, userId],
      );
      const row = result.rows[0];
      return row ? toPersonalAccessToken(row) : null;
    },

    async listForUser(userId) {
      const result = await client.query(
        `SELECT * FROM personal_access_tokens
          WHERE user_id = $1
          ORDER BY created_at DESC, id DESC`,
        [userId],
      );
      return result.rows.map(toPersonalAccessToken);
    },

    async touch(id) {
      await client.query(
        "UPDATE personal_access_tokens SET last_used_at = now() WHERE id = $1",
        [id],
      );
    },

    async rename(userId, id, name) {
      const result = await client.query(
        `UPDATE personal_access_tokens SET name = $3
          WHERE id = $1 AND user_id = $2
      RETURNING *`,
        [id, userId, name],
      );
      const row = result.rows[0];
      return row ? toPersonalAccessToken(row) : null;
    },

    async revoke(userId, id) {
      const result = await client.query(
        `UPDATE personal_access_tokens SET revoked_at = now()
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [id, userId],
      );
      return result.rowCount > 0;
    },
  };
}
