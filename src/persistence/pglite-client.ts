/**
 * The test SQL client: PGlite, PostgreSQL compiled to WebAssembly.
 *
 * This is what makes the persistence layer honestly tested. Repositories are
 * written in PostgreSQL SQL, and these tests run that SQL against a real
 * PostgreSQL 18 engine — constraints, `ON CONFLICT`, `UPDATE ... RETURNING`,
 * transactions and rollbacks included — with no server to install, no container
 * to start, and no shared state between test files.
 *
 * It is not a production driver: one in-process database, no pool, no network.
 * `createPostgresClient` is the deployed one, and both satisfy the same port,
 * which is the only reason a single repository implementation can serve both.
 */
import { PGlite } from "@electric-sql/pglite";
import type { SqlClient, SqlResult, SqlValue } from "./sql-client";
import { toDriverValue } from "./sql-client";

/** Where a test database keeps its data. */
export interface PgliteOptions {
  /** `memory://` (default) for an ephemeral database, or a directory path. */
  dataDir?: string;
}

/** Open an in-process PostgreSQL for tests. */
export function createPgliteClient(options: PgliteOptions = {}): SqlClient {
  const database = new PGlite(options.dataDir ?? "memory://");

  const query = async (
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlResult> => {
    const result = await database.query<Record<string, unknown>>(
      sql,
      params.map(toDriverValue),
    );
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  };

  const client: SqlClient = {
    query,

    async transaction<T>(work: (tx: SqlClient) => Promise<T>): Promise<T> {
      // One connection, so the callback can run on the same object: there is no
      // pool to check out and no correctness reason to wrap it again.
      await database.exec("BEGIN");
      try {
        const value = await work(client);
        await database.exec("COMMIT");
        return value;
      } catch (error) {
        await database.exec("ROLLBACK").catch(() => {});
        throw error;
      }
    },

    async close() {
      await database.close();
    },
  };

  return client;
}
