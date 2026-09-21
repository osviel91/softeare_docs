/**
 * The deployed SQL client: PostgreSQL through `pg`.
 *
 * The only file in the server that knows a database driver exists. It satisfies
 * {@link SqlClient} — the port every repository is written against — and adds
 * what a pool needs: a connection string, a size, and a timeout.
 *
 * `pg` returns `numeric` and `bigint` as strings to avoid precision loss; the
 * schema here uses `integer` for revisions and `uuid` for ids, so nothing the
 * server reads arrives as an unexpected string. Dates do arrive as `Date`, which
 * is what the repositories expect.
 */
import { Pool, type PoolClient } from "pg";
import type { SqlClient, SqlResult, SqlValue } from "./sql-client";

/** How to reach the database. */
export interface PostgresOptions {
  /** A libpq connection string (`postgres://user:pass@host:5432/db`). */
  connectionString: string;
  /** Maximum pooled connections. Defaults to 10. */
  max?: number;
  /** How long to wait for a connection before failing, in milliseconds. */
  connectionTimeoutMillis?: number;
}

/** Map our parameter type onto what `pg` accepts. */
function toDriverValue(value: SqlValue): unknown {
  if (value === undefined) return null;
  return value;
}

/** Wrap a pool or a checked-out client as a {@link SqlClient}. */
function clientOver(
  executor: Pool | PoolClient,
  options: { pooled: boolean; release: () => Promise<void> },
): SqlClient {
  const run = async (
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlResult> => {
    const result = await executor.query(sql, params.map(toDriverValue));
    return {
      rows: result.rows as SqlResult["rows"],
      rowCount: result.rowCount ?? 0,
    };
  };

  return {
    query: run,

    async transaction<T>(work: (tx: SqlClient) => Promise<T>): Promise<T> {
      // A pooled client checks out one connection for the whole transaction; a
      // client already inside a transaction (the nested case) runs on it
      // directly. Repositories never nest, so no savepoint is needed.
      const client = options.pooled
        ? await (executor as Pool).connect()
        : (executor as PoolClient);
      try {
        await client.query("BEGIN");
        const nested = clientOver(client, {
          pooled: false,
          release: async () => {},
        });
        const value = await work(nested);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        if (options.pooled) client.release();
      }
    },

    close: options.release,
  };
}

/** Open a pooled connection to PostgreSQL. */
export function createPostgresClient(options: PostgresOptions): SqlClient {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
  });
  return clientOver(pool, {
    pooled: true,
    release: async () => {
      await pool.end();
    },
  });
}
