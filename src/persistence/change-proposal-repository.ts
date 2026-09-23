import type {
  ChangeProposal,
  ChangeProposalStatus,
} from "../domain/workspace/change-proposal";
import { normalizeResourceMetadata, parseResourceMetadata } from "../domain/workspace/resource-metadata";
import type { ResourceAuthorship } from "../domain/workspace/resource-revision";
import type {
  ChangeProposalChanges,
  ChangeProposalRepository,
  NewChangeProposal,
} from "../application/ports/change-proposal-repository";
import type { SqlClient, SqlValue } from "./sql-client";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";
import { integer, text } from "./rows";

function proposalOf(row: Record<string, unknown>): ChangeProposal {
  const metadata = parseResourceMetadata(row.proposed_metadata);
  const author = typeof row.authorship === "string" ? JSON.parse(row.authorship) : row.authorship;
  return {
    id: text(row, "id"),
    resourceId: text(row, "resource_id"),
    baseRevision: integer(row, "base_revision"),
    proposedContent: text(row, "proposed_content"),
    ...(metadata === undefined ? {} : { proposedMetadata: metadata }),
    title: text(row, "title"),
    ...(row.description === null || row.description === undefined
      ? {}
      : { description: text(row, "description") }),
    author: author as ResourceAuthorship,
    status: text(row, "status") as ChangeProposalStatus,
    version: integer(row, "proposal_version"),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
  };
}

export function createChangeProposalRepository(
  client: SqlClient,
  options: { newId?: IdGenerator } = {},
): ChangeProposalRepository {
  const newId = options.newId ?? createIdGenerator();
  return {
    async create(input: NewChangeProposal) {
      const result = await client.query(
        `INSERT INTO change_proposals
          (id, resource_id, base_revision, proposed_content, proposed_metadata,
           title, description, authorship)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb)
         RETURNING *`,
        [
          newId(),
          input.resourceId,
          input.baseRevision,
          input.proposedContent,
          JSON.stringify(normalizeResourceMetadata(input.proposedMetadata)),
          input.title,
          input.description ?? null,
          JSON.stringify(input.author),
        ],
      );
      return proposalOf(result.rows[0]);
    },
    async get(id) {
      const result = await client.query("SELECT * FROM change_proposals WHERE id = $1", [id]);
      return result.rows[0] ? proposalOf(result.rows[0]) : null;
    },
    async list(resourceId) {
      const result = await client.query(
        "SELECT * FROM change_proposals WHERE resource_id = $1 ORDER BY created_at ASC, id ASC",
        [resourceId],
      );
      return result.rows.map(proposalOf);
    },
    async update(id, expectedVersion, changes: ChangeProposalChanges) {
      const assignments: string[] = [];
      const params: SqlValue[] = [id, expectedVersion];
      if (changes.proposedContent !== undefined) {
        params.push(changes.proposedContent);
        assignments.push(`proposed_content = $${params.length}`);
      }
      if (changes.proposedMetadata !== undefined) {
        params.push(JSON.stringify(normalizeResourceMetadata(changes.proposedMetadata)));
        assignments.push(`proposed_metadata = $${params.length}::jsonb`);
      }
      if (changes.title !== undefined) {
        params.push(changes.title);
        assignments.push(`title = $${params.length}`);
      }
      if (changes.description !== undefined) {
        params.push(changes.description);
        assignments.push(`description = $${params.length}`);
      }
      if (assignments.length === 0) return this.get(id);
      assignments.push("proposal_version = proposal_version + 1", "updated_at = now()");
      const result = await client.query(
        `UPDATE change_proposals SET ${assignments.join(", ")}
         WHERE id = $1 AND proposal_version = $2 AND status <> 'closed'
         RETURNING *`,
        params,
      );
      return result.rows[0] ? proposalOf(result.rows[0]) : null;
    },
    async transition(id, expectedVersion, from, to) {
      const result = await client.query(
        `UPDATE change_proposals
            SET status = $4, proposal_version = proposal_version + 1, updated_at = now()
          WHERE id = $1 AND proposal_version = $2 AND status = $3
        RETURNING *`,
        [id, expectedVersion, from, to],
      );
      return result.rows[0] ? proposalOf(result.rows[0]) : null;
    },
  };
}
