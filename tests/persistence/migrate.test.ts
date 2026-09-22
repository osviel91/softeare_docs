// @vitest-environment node
/**
 * Migrations and the initial schema (ADR-040).
 *
 * These tests do two jobs. They prove the runner is ordered and idempotent, and
 * they prove the schema itself is a boundary: a stored resource path that
 * traverses, an unknown role, an unknown resource type, or a non-positive
 * revision must be refused by the *database* as well as by the application. A
 * constraint that only exists in TypeScript is a constraint a future migration,
 * import script or `psql` session can walk around.
 */
import { describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  migrate,
  splitStatements,
} from "../../src/persistence/migrate";
import { createPgliteClient } from "../../src/persistence/pglite-client";
import {
  openTestDatabase,
  closeTestDatabase,
  insertTestUser,
  testUuid,
} from "./test-database";

describe("splitStatements", () => {
  it("splits a migration into its statements", () => {
    const statements = splitStatements(
      "CREATE TABLE a (x int); CREATE TABLE b (y int);",
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/CREATE TABLE a/);
  });

  it("ignores empty statements from trailing semicolons", () => {
    expect(splitStatements("SELECT 1;;\n\n;")).toEqual(["SELECT 1"]);
  });

  it("keeps every migration free of constructs the splitter cannot handle", () => {
    for (const migration of MIGRATIONS) {
      expect(migration.sql).not.toMatch(/\$\$/); // no dollar-quoted bodies
      expect(migration.sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
      expect(migration.sql).not.toMatch(/--[^\n]*;[^\n]*\n/); // no semicolon in a comment
    }
  });
});

describe("migrate", () => {
  it("applies every migration to an empty database", async () => {
    const client = await createPgliteClient();
    try {
      const report = await migrate(client);
      expect(report.applied).toEqual([1, 2, 3, 4]);
      expect(report.present).toEqual([]);
      const tables = await client.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' ORDER BY table_name`,
      );
      const names = tables.rows.map((row) => String(row.table_name));
      for (const expected of [
        "agent_credential_projects",
        "agent_credentials",
        "agent_identities",
        "audit_events",
        "project_members",
        "projects",
        "resources",
        "schema_migrations",
        "sessions",
        "users",
        "workspace_operations",
        "idempotency_records",
      ]) {
        expect(names).toContain(expected);
      }
      // Migration 0002 replaced the user-owned token table with the agent model.
      expect(names).not.toContain("personal_access_tokens");
    } finally {
      await client.close();
    }
  });

  it("is idempotent: running it twice changes nothing", async () => {
    const client = await createPgliteClient();
    try {
      await migrate(client);
      const second = await migrate(client);
      expect(second.applied).toEqual([]);
       expect(second.present).toEqual([1, 2, 3, 4]);
    } finally {
      await client.close();
    }
  });

  it("applies migrations in ascending version order", async () => {
    const client = await createPgliteClient();
    try {
      const report = await migrate(client, [
        { version: 20, name: "later", sql: "CREATE TABLE later (x int);" },
        { version: 10, name: "earlier", sql: "CREATE TABLE earlier (x int);" },
      ]);
      expect(report.applied).toEqual([10, 20]);
    } finally {
      await client.close();
    }
  });

  it("rolls a failed migration back completely", async () => {
    const client = await createPgliteClient();
    try {
      await expect(
        migrate(client, [
          {
            version: 1,
            name: "half-broken",
            sql: "CREATE TABLE half (x int); CREATE TABLE half (x int);",
          },
        ]),
      ).rejects.toThrow();
      const tables = await client.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'half'`,
      );
      expect(tables.rows).toHaveLength(0);
      const history = await client.query(
        "SELECT version FROM schema_migrations",
      );
      expect(history.rows).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});

describe("schema constraints", () => {
  it("refuses a duplicate identity", async () => {
    const client = await openTestDatabase();
    try {
      await insertTestUser(client, { id: testUuid(1), subject: "s1" });
      await expect(
        insertTestUser(client, { id: testUuid(2), subject: "s1" }),
      ).rejects.toThrow();
    } finally {
      await closeTestDatabase(client);
    }
  });

  it("allows the same subject at a different issuer", async () => {
    const client = await openTestDatabase();
    try {
      await insertTestUser(client, {
        id: testUuid(1),
        issuer: "https://a.test",
        subject: "s",
      });
      await insertTestUser(client, {
        id: testUuid(2),
        issuer: "https://b.test",
        subject: "s",
      });
      const rows = await client.query(
        "SELECT count(*)::int AS count FROM users",
      );
      expect(rows.rows[0].count).toBe(2);
    } finally {
      await closeTestDatabase(client);
    }
  });

  it("refuses an unknown project role", async () => {
    const client = await openTestDatabase();
    try {
      await insertTestUser(client, { id: testUuid(1) });
      await client.query(
        "INSERT INTO projects (id, owner_id, name, slug) VALUES ($1, $2, $3, $4)",
        [testUuid(10), testUuid(1), "Payments", "payments"],
      );
      await expect(
        client.query(
          "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)",
          [testUuid(10), testUuid(1), "SUPERUSER"],
        ),
      ).rejects.toThrow();
    } finally {
      await closeTestDatabase(client);
    }
  });

  it("refuses an unknown resource type", async () => {
    const client = await openTestDatabase();
    try {
      await insertTestUser(client, { id: testUuid(1) });
      await client.query(
        "INSERT INTO projects (id, owner_id, name, slug) VALUES ($1, $2, $3, $4)",
        [testUuid(10), testUuid(1), "Payments", "payments"],
      );
      await expect(
        client.query(
          "INSERT INTO resources (id, project_id, path, type) VALUES ($1, $2, $3, $4)",
          [testUuid(20), testUuid(10), "a.seq", "spreadsheet"],
        ),
      ).rejects.toThrow();
    } finally {
      await closeTestDatabase(client);
    }
  });

  it("refuses a traversal, absolute or backslash resource path", async () => {
    const client = await openTestDatabase();
    try {
      await insertTestUser(client, { id: testUuid(1) });
      await client.query(
        "INSERT INTO projects (id, owner_id, name, slug) VALUES ($1, $2, $3, $4)",
        [testUuid(10), testUuid(1), "Payments", "payments"],
      );
      const bad = [
        "../escape.seq",
        "docs/../../escape.seq",
        "/etc/passwd",
        "docs\\a.md",
        "./a.md",
        "docs/./a.md",
      ];
      for (const [index, path] of bad.entries()) {
        await expect(
          client.query(
            "INSERT INTO resources (id, project_id, path, type) VALUES ($1, $2, $3, $4)",
            [testUuid(30 + index), testUuid(10), path, "sequence-diagram"],
          ),
        ).rejects.toThrow();
      }
    } finally {
      await closeTestDatabase(client);
    }
  });

  it("refuses a non-positive revision", async () => {
    const client = await openTestDatabase();
    try {
      await insertTestUser(client, { id: testUuid(1) });
      await client.query(
        "INSERT INTO projects (id, owner_id, name, slug) VALUES ($1, $2, $3, $4)",
        [testUuid(10), testUuid(1), "Payments", "payments"],
      );
      await expect(
        client.query(
          "INSERT INTO resources (id, project_id, path, type, revision) VALUES ($1, $2, $3, $4, $5)",
          [testUuid(20), testUuid(10), "a.seq", "sequence-diagram", 0],
        ),
      ).rejects.toThrow();
    } finally {
      await closeTestDatabase(client);
    }
  });

  it("refuses two resources at the same path in one project", async () => {
    const client = await openTestDatabase();
    try {
      await insertTestUser(client, { id: testUuid(1) });
      await client.query(
        "INSERT INTO projects (id, owner_id, name, slug) VALUES ($1, $2, $3, $4)",
        [testUuid(10), testUuid(1), "Payments", "payments"],
      );
      await client.query(
        "INSERT INTO resources (id, project_id, path, type) VALUES ($1, $2, $3, $4)",
        [testUuid(20), testUuid(10), "a.seq", "sequence-diagram"],
      );
      await expect(
        client.query(
          "INSERT INTO resources (id, project_id, path, type) VALUES ($1, $2, $3, $4)",
          [testUuid(21), testUuid(10), "a.seq", "sequence-diagram"],
        ),
      ).rejects.toThrow();
    } finally {
      await closeTestDatabase(client);
    }
  });

  it("allows the same path in two different projects", async () => {
    const client = await openTestDatabase();
    try {
      await insertTestUser(client, { id: testUuid(1) });
      for (const [index, id] of ["payments", "ledger"].entries()) {
        const projectId = testUuid(10 + index);
        await client.query(
          "INSERT INTO projects (id, owner_id, name, slug) VALUES ($1, $2, $3, $4)",
          [projectId, testUuid(1), `Project ${id}`, id],
        );
        await client.query(
          "INSERT INTO resources (id, project_id, path, type) VALUES ($1, $2, $3, $4)",
          [testUuid(20 + index), projectId, "a.seq", "sequence-diagram"],
        );
      }
      const rows = await client.query(
        "SELECT count(*)::int AS count FROM resources",
      );
      expect(rows.rows[0].count).toBe(2);
    } finally {
      await closeTestDatabase(client);
    }
  });

  it("deletes a project's resources and members with it", async () => {
    const client = await openTestDatabase();
    try {
      await insertTestUser(client, { id: testUuid(1) });
      await insertTestUser(client, { id: testUuid(2) });
      await client.query(
        "INSERT INTO projects (id, owner_id, name, slug) VALUES ($1, $2, $3, $4)",
        [testUuid(10), testUuid(1), "Payments", "payments"],
      );
      await client.query(
        "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)",
        [testUuid(10), testUuid(2), "VIEWER"],
      );
      await client.query(
        "INSERT INTO resources (id, project_id, path, type) VALUES ($1, $2, $3, $4)",
        [testUuid(20), testUuid(10), "a.seq", "sequence-diagram"],
      );
      await client.query("DELETE FROM projects WHERE id = $1", [testUuid(10)]);
      const resources = await client.query(
        "SELECT count(*)::int AS count FROM resources",
      );
      const members = await client.query(
        "SELECT count(*)::int AS count FROM project_members",
      );
      expect(resources.rows[0].count).toBe(0);
      expect(members.rows[0].count).toBe(0);
    } finally {
      await closeTestDatabase(client);
    }
  });
});
