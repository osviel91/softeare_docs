/**
 * The migration runner (ADR-040).
 *
 * A migration is one SQL string applied inside one transaction together with
 * the row that records it, so the schema and its history can never disagree: a
 * failure leaves no partial schema and no entry. Running the migrations twice is
 * a no-op, which is what makes every process start with `migrate()` rather than
 * a documented manual step nobody performs.
 *
 * The runner splits the SQL on statement boundaries itself. A multi-statement
 * simple query cannot carry bind parameters, and the transaction wrapper needs
 * statements it can send individually.
 */
import type { SqlClient } from "./sql-client";
import { up as initialSchema } from "./migrations/0001-initial-schema";
import { up as agentCredentials } from "./migrations/0002-agent-credentials";
import { up as workspaceOperations } from "./migrations/0003-workspace-operations";
import { up as accountApproval } from "./migrations/0004-account-approval";
import { up as workspaces } from "./migrations/0005-workspaces";
import { up as localCredentials } from "./migrations/0006-local-credentials";
import { up as userIdentities } from "./migrations/0007-user-identities";
import { up as workspaceLifecycle } from "./migrations/0008-workspace-lifecycle";
import { up as resourceMetadata } from "./migrations/0009-resource-metadata";
import { up as resourceRevisions } from "./migrations/0010-resource-revisions";
import { up as changeProposals } from "./migrations/0011-change-proposals";
import { up as mergedProposals } from "./migrations/0012-merged-proposals";
import { up as mergeSchemaRepair } from "./migrations/0013-merge-schema-repair";
import { repairMergeSchema } from "./migrations/0013-merge-schema-repair";
import { up as mergedStatusConstraint } from "./migrations/0014-merged-status-constraint";

/** One migration: a stable name and the SQL that applies it. */
export interface Migration {
  /** Sort key and identity. Applied in ascending order, never reordered. */
  version: number;
  /** A short human name, recorded for diagnostics. */
  name: string;
  /** The statements to apply, in order. */
  sql: string;
}

/** Every migration the server knows, oldest first. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial-schema", sql: initialSchema },
  { version: 2, name: "agent-credentials", sql: agentCredentials },
  { version: 3, name: "workspace-operations", sql: workspaceOperations },
  { version: 4, name: "account-approval", sql: accountApproval },
  { version: 5, name: "workspaces", sql: workspaces },
  { version: 6, name: "local-credentials", sql: localCredentials },
  { version: 7, name: "user-identities", sql: userIdentities },
  { version: 8, name: "workspace-lifecycle", sql: workspaceLifecycle },
  { version: 9, name: "resource-metadata", sql: resourceMetadata },
  { version: 10, name: "resource-revisions", sql: resourceRevisions },
  { version: 11, name: "change-proposals", sql: changeProposals },
  { version: 12, name: "merged-proposals", sql: mergedProposals },
  { version: 13, name: "merge-schema-repair", sql: mergeSchemaRepair },
  { version: 14, name: "merged-status-constraint", sql: mergedStatusConstraint },
];

/**
 * Split a migration into statements.
 *
 * Splitting on `;` is safe here because these migrations contain no function
 * bodies, no dollar-quoted strings and no semicolons inside literals — a
 * constraint the migration tests assert, so a future migration that breaks it
 * fails loudly rather than being applied halfway.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

/** The result of a migration run. */
export interface MigrationReport {
  /** The versions applied by this run, in order. Empty when already current. */
  applied: number[];
  /** The versions already present before this run. */
  present: number[];
}

/** Create the history table if this is a fresh database. */
async function ensureHistoryTable(client: SqlClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    integer PRIMARY KEY,
       name       text        NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

/** The versions already applied, in ascending order. */
async function appliedVersions(client: SqlClient): Promise<number[]> {
  const result = await client.query(
    "SELECT version FROM schema_migrations ORDER BY version ASC",
  );
  return result.rows.map((row) => Number(row.version));
}

/**
 * Apply every migration the database is missing.
 *
 * @param client - The database to migrate.
 * @param migrations - The migrations to apply; injectable so a test can prove
 *   the runner's ordering and idempotence without a second schema.
 */
export async function migrate(
  client: SqlClient,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrationReport> {
  await ensureHistoryTable(client);
  const present = await appliedVersions(client);
  const known = new Set(present);
  const applied: number[] = [];

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of ordered) {
    if (known.has(migration.version)) continue;
    await client.transaction(async (tx) => {
      for (const statement of splitStatements(migration.sql)) {
        await tx.query(statement);
      }
      await tx.query(
        "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
    });
    applied.push(migration.version);
  }

  // H20.2.1: repair merge columns even when a drifted database falsely records
  // the repair migration as applied.
  await repairMergeSchema(client);

  return { applied, present };
}
