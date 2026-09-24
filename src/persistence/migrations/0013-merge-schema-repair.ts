import type { SqlClient } from "../sql-client";

/** Migration 0013: repair merge provenance columns on drifted deployments. */
export const up = String.raw`
ALTER TABLE change_proposals
  ADD COLUMN IF NOT EXISTS merge_authorship jsonb,
  ADD COLUMN IF NOT EXISTS merged_at timestamptz,
  ADD COLUMN IF NOT EXISTS merged_revision integer;
`;

/** Re-assert the merge schema when migration history is incomplete or wrong. */
export async function repairMergeSchema(client: SqlClient): Promise<void> {
  const table = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'change_proposals'",
  );
  if (table.rows.length === 0) return;
  for (const statement of up.split(";").map((item) => item.trim()).filter(Boolean))
    await client.query(statement);
}
