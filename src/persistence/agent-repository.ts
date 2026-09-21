/**
 * Agent identities and credentials over PostgreSQL (ADR-043, Phase 5).
 *
 * The implementation of the two ports in
 * `src/application/ports/agent-repository.ts`. Two structural decisions live
 * here:
 *
 * - **Ownership is a join, not a check.** A credential belongs to an agent,
 *   which belongs to a user, so every user-addressed lookup joins
 *   `agent_identities` and filters on `owner_user_id`. A caller cannot forget
 *   the check because there is no un-owned method to call.
 * - **Project restrictions are a join table.** `agent_credential_projects` is
 *   read into `allowedProjectIds` on every credential fetch, so the
 *   authorization policy sees the restriction without a second query and a
 *   restriction cannot be "forgotten" by a code path that forgot to load it.
 *
 * The secret is only ever a digest here: `token_hash` is written once and never
 * selected into a value a caller could return as a credential.
 */
import type {
  AgentCredentialRepository,
  AgentIdentityRepository,
  NewAgentCredential,
  NewAgentIdentity,
} from "../application/ports/agent-repository";
import type {
  AgentCredential,
  AgentCredentialWithAgent,
  AgentIdentity,
} from "../domain/agent/agent";
import type { CredentialScope } from "../domain/access/permissions";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";
import { textArray, timestamp, timestampOrNull } from "./rows";
import type { SqlClient, SqlRow } from "./sql-client";

/** Options for both repositories. */
export interface AgentRepositoryOptions {
  /** Injectable so a test gets deterministic ids. */
  newId?: IdGenerator;
}

/** The subquery that folds a credential's restrictions into one array. */
const PROJECT_IDS_SUBQUERY = `COALESCE(
  (SELECT array_agg(p.project_id::text)
     FROM agent_credential_projects p
    WHERE p.credential_id = c.id),
  '{}'::text[]
) AS project_ids`;

/** Map an `agent_identities` row. */
export function toAgentIdentity(row: SqlRow): AgentIdentity {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    description:
      row.description === null || row.description === undefined
        ? null
        : String(row.description),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
    disabledAt: timestampOrNull(row, "disabled_at"),
  };
}

/** Map an `agent_credentials` row (with its folded `project_ids`). */
export function toAgentCredential(row: SqlRow): AgentCredential {
  const projectIds = textArray(row, "project_ids");
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    name: String(row.name),
    publicPrefix: String(row.token_prefix),
    secretHash: String(row.token_hash),
    scopes: textArray(row, "scopes") as CredentialScope[],
    // An absent or empty restriction means "no narrowing beyond membership".
    allowedProjectIds: projectIds.length === 0 ? null : projectIds,
    createdAt: timestamp(row, "created_at"),
    expiresAt: timestampOrNull(row, "expires_at"),
    lastUsedAt: timestampOrNull(row, "last_used_at"),
    revokedAt: timestampOrNull(row, "revoked_at"),
  };
}

/** Map a joined credential+agent row. */
function toCredentialWithAgent(row: SqlRow): AgentCredentialWithAgent | null {
  const agentJson = row.agent_json;
  if (typeof agentJson !== "object" || agentJson === null) return null;
  return {
    credential: toAgentCredential(row),
    agent: toAgentIdentity(agentJson as SqlRow),
  };
}

/** The identity repository over a `SqlClient`. */
export function createAgentIdentityRepository(
  client: SqlClient,
  options: AgentRepositoryOptions = {},
): AgentIdentityRepository {
  const newId = options.newId ?? createIdGenerator();

  return {
    async create(input: NewAgentIdentity) {
      const result = await client.query(
        `INSERT INTO agent_identities (id, owner_user_id, name, description)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [
          input.id ?? newId(),
          input.ownerUserId,
          input.name,
          input.description ?? null,
        ],
      );
      return toAgentIdentity(result.rows[0]);
    },

    async findById(id) {
      const result = await client.query(
        "SELECT * FROM agent_identities WHERE id = $1",
        [id],
      );
      const row = result.rows[0];
      return row ? toAgentIdentity(row) : null;
    },

    async findByIdForUser(ownerUserId, id) {
      const result = await client.query(
        "SELECT * FROM agent_identities WHERE id = $1 AND owner_user_id = $2",
        [id, ownerUserId],
      );
      const row = result.rows[0];
      return row ? toAgentIdentity(row) : null;
    },

    async listForUser(ownerUserId) {
      const result = await client.query(
        `SELECT * FROM agent_identities
          WHERE owner_user_id = $1
          ORDER BY created_at ASC, id ASC`,
        [ownerUserId],
      );
      return result.rows.map(toAgentIdentity);
    },

    async update(ownerUserId, id, changes) {
      const result = await client.query(
        `UPDATE agent_identities
            SET name = COALESCE($3, name),
                description = CASE WHEN $4::boolean THEN $5 ELSE description END,
                updated_at = now()
          WHERE id = $1 AND owner_user_id = $2
      RETURNING *`,
        [
          id,
          ownerUserId,
          changes.name ?? null,
          changes.description !== undefined,
          changes.description ?? null,
        ],
      );
      const row = result.rows[0];
      return row ? toAgentIdentity(row) : null;
    },

    async setDisabled(ownerUserId, id, disabled) {
      const result = await client.query(
        `UPDATE agent_identities
            SET disabled_at = CASE WHEN $3 THEN now() ELSE NULL END,
                updated_at = now()
          WHERE id = $1 AND owner_user_id = $2
      RETURNING *`,
        [id, ownerUserId, disabled],
      );
      const row = result.rows[0];
      return row ? toAgentIdentity(row) : null;
    },
  };
}

/** The credential repository over a `SqlClient`. */
export function createAgentCredentialRepository(
  client: SqlClient,
  options: AgentRepositoryOptions = {},
): AgentCredentialRepository {
  const newId = options.newId ?? createIdGenerator();

  const loadById = async (
    where: string,
    params: readonly (string | null)[],
  ): Promise<AgentCredentialWithAgent | null> => {
    const result = await client.query(
      `SELECT c.*, ${PROJECT_IDS_SUBQUERY}, row_to_json(a.*) AS agent_json
         FROM agent_credentials c
         JOIN agent_identities a ON a.id = c.agent_id
        WHERE ${where}`,
      params,
    );
    const row = result.rows[0];
    return row ? toCredentialWithAgent(row) : null;
  };

  return {
    async create(input: NewAgentCredential) {
      const id = input.id ?? newId();
      const projectIds =
        input.allowedProjectIds === undefined ||
        input.allowedProjectIds === null
          ? null
          : [...input.allowedProjectIds];
      return client.transaction(async (tx) => {
        const result = await tx.query(
          `INSERT INTO agent_credentials
             (id, agent_id, name, token_prefix, token_hash, scopes, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            id,
            input.agentId,
            input.name,
            input.publicPrefix,
            input.secretHash,
            [...input.scopes],
            input.expiresAt ?? null,
          ],
        );
        if (projectIds !== null) {
          for (const projectId of projectIds) {
            await tx.query(
              `INSERT INTO agent_credential_projects (credential_id, project_id)
               VALUES ($1, $2)`,
              [id, projectId],
            );
          }
        }
        // The row mapper expects the folded `project_ids` column, so the created
        // value is assembled from the input rather than re-read.
        return {
          ...toAgentCredential(result.rows[0]),
          allowedProjectIds: projectIds,
        };
      });
    },

    async findByPrefix(publicPrefix) {
      return loadById("c.token_prefix = $1", [publicPrefix]);
    },

    async findById(id) {
      return loadById("c.id = $1", [id]);
    },

    async findByIdForUser(ownerUserId, credentialId) {
      return loadById("c.id = $1 AND a.owner_user_id = $2", [
        credentialId,
        ownerUserId,
      ]);
    },

    async listForAgent(agentId) {
      const result = await client.query(
        `SELECT c.*, ${PROJECT_IDS_SUBQUERY}
           FROM agent_credentials c
          WHERE c.agent_id = $1
          ORDER BY c.created_at DESC, c.id DESC`,
        [agentId],
      );
      return result.rows.map(toAgentCredential);
    },

    async countForAgent(agentId) {
      const result = await client.query(
        "SELECT count(*)::int AS count FROM agent_credentials WHERE agent_id = $1",
        [agentId],
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async touch(id) {
      await client.query(
        "UPDATE agent_credentials SET last_used_at = now() WHERE id = $1",
        [id],
      );
    },

    async revoke(agentId, credentialId) {
      const result = await client.query(
        `UPDATE agent_credentials SET revoked_at = now()
          WHERE id = $1 AND agent_id = $2 AND revoked_at IS NULL`,
        [credentialId, agentId],
      );
      return result.rowCount > 0;
    },

    async setAllowedProjects(credentialId, projectIds) {
      await client.transaction(async (tx) => {
        await tx.query(
          "DELETE FROM agent_credential_projects WHERE credential_id = $1",
          [credentialId],
        );
        for (const projectId of projectIds ?? []) {
          await tx.query(
            `INSERT INTO agent_credential_projects (credential_id, project_id)
             VALUES ($1, $2)`,
            [credentialId, projectId],
          );
        }
      });
    },
  };
}
