import type { ProjectStorage } from "../application/project-storage";
import type { SqlClient } from "./sql-client";
import { isOk } from "../shared/result/result";

/**
 * Backfill the honest H13 boundary for resources created before snapshots.
 * Missing files are an operational inconsistency, not a reason to invent text.
 */
export async function backfillResourceRevisionBaselines(
  client: SqlClient,
  storageFor: (projectId: string) => ProjectStorage,
): Promise<void> {
  const resources = await client.query(
    "SELECT id, project_id, path, type, metadata, revision FROM resources",
  );
  const baselines: Array<{
    id: string;
    projectId: string;
    path: string;
    type: string;
    metadata: unknown;
    revision: number;
    content: string;
  }> = [];

  for (const row of resources.rows) {
    const existing = await client.query(
      "SELECT 1 FROM resource_revisions WHERE resource_id = $1 LIMIT 1",
      [String(row.id)],
    );
    if (existing.rows.length > 0) continue;
    const stored = await storageFor(String(row.project_id)).read(
      String(row.path),
    );
    if (!isOk(stored)) {
      throw new Error(
        `Could not read resource ${String(row.id)} for history backfill: ${stored.error.message}`,
      );
    }
    if (stored.value === null) {
      throw new Error(
        `Resource ${String(row.id)} is missing its canonical file.`,
      );
    }
    baselines.push({
      id: String(row.id),
      projectId: String(row.project_id),
      path: String(row.path),
      type: String(row.type),
      metadata: row.metadata,
      revision: Number(row.revision),
      content: stored.value.content,
    });
  }

  if (baselines.length === 0) return;
  await client.transaction(async (tx) => {
    for (const baseline of baselines) {
      await tx.query(
        `INSERT INTO resource_revisions
          (resource_id, revision, content, type, metadata, authorship)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (resource_id, revision) DO NOTHING`,
        [
          baseline.id,
          baseline.revision,
          baseline.content,
          baseline.type,
          typeof baseline.metadata === "string"
            ? baseline.metadata
            : JSON.stringify(baseline.metadata ?? {}),
          JSON.stringify({ kind: "system" }),
        ],
      );
    }
  });
}
