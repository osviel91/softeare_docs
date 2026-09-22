// @vitest-environment node
/**
 * Open a PGlite database for a test and bring it up to date.
 *
 * Every test file gets its own in-memory PostgreSQL, so tests neither share
 * state nor need a database server. `@electric-sql/pglite` is a dev dependency
 * for exactly this reason: the persistence layer is written in PostgreSQL SQL,
 * and the only honest way to test it is against PostgreSQL.
 */
import { createPgliteClient } from "../../src/persistence/pglite-client";
import { migrate } from "../../src/persistence/migrate";
import type { SqlClient } from "../../src/persistence/sql-client";

/** A migrated, empty database. */
export async function openTestDatabase(): Promise<SqlClient> {
  const client = await createPgliteClient();
  await migrate(client);
  return client;
}

/** Close a test database, tolerating an already-closed one. */
export async function closeTestDatabase(client: SqlClient): Promise<void> {
  await client.close().catch(() => {});
}

/** Insert a user directly, for tests about projects rather than identity. */
export async function insertTestUser(
  client: SqlClient,
  values: {
    id: string;
    issuer?: string;
    subject?: string;
    displayName?: string;
    email?: string | null;
  },
): Promise<string> {
  await client.query(
    `INSERT INTO users (id, identity_issuer, identity_subject, display_name, email)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      values.id,
      values.issuer ?? "https://idp.test",
      values.subject ?? `subject-${values.id}`,
      values.displayName ?? "Test User",
      values.email ?? null,
    ],
  );
  await client.query(
    `INSERT INTO workspaces (id, name) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [values.id, `${values.displayName ?? "Test User"} Workspace`],
  );
  await client.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1, $1, 'ADMIN') ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [values.id],
  );
  return values.id;
}

/**
 * A valid UUID for a test fixture.
 *
 * The schema types ids as `uuid`, and PostgreSQL validates the *shape*, so a
 * fixture cannot get away with `"u1"` — which is a useful property to keep
 * rather than work around: it means a test proves the column really is a uuid.
 */
export function testUuid(
  n: number,
  prefix = "00000000-0000-7000-8000-",
): string {
  return prefix + n.toString(16).padStart(12, "0");
}
