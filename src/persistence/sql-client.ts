/**
 * The SQL client port (ADR-040).
 *
 * Repositories are written once, in SQL, against this interface — never against
 * a driver. Two implementations satisfy it: `pg` for a deployed PostgreSQL, and
 * PGlite (PostgreSQL 18 compiled to WebAssembly) for tests, which is why the
 * persistence tests exercise real SQL semantics — constraints, `ON CONFLICT`,
 * `UPDATE ... RETURNING` — with no database server to start.
 *
 * Two deliberate limitations keep the port honest:
 *
 * - **Placeholders are `$1, $2, ...`.** Both implementations speak PostgreSQL's
 *   own convention, so a repository's SQL is the SQL that runs.
 * - **No server-side SQL is assembled from user input**, only from constants.
 *   Values always travel as parameters; a path or a login name never becomes
 *   part of a statement's text.
 */
import type { JsonValue } from "../shared/json/json-value";

/** A value that can be bound to a statement parameter. */
export type SqlValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | readonly string[]
  | readonly number[];

/** One result row, keyed by column name. */
export type SqlRow = Record<string, unknown>;

/** The result of running a statement. */
export interface SqlResult {
  /** Rows returned (`RETURNING`, `SELECT`), or an empty array. */
  rows: SqlRow[];
  /** Rows affected, where the driver reports it. */
  rowCount: number;
}

/** A connection (or pool) a repository runs statements on. */
export interface SqlClient {
  /** Run one statement with bound parameters. */
  query(sql: string, params?: readonly SqlValue[]): Promise<SqlResult>;

  /**
   * Run several statements atomically.
   *
   * The callback receives a client bound to the transaction; a throw rolls the
   * whole thing back, which is how "apply the migration and record it" and
   * "update the resource and audit it" stay one unit.
   */
  transaction<T>(run: (tx: SqlClient) => Promise<T>): Promise<T>;

  /** Release the connection or pool. Idempotent. */
  close(): Promise<void>;
}

/** Re-exported so a repository can name the `jsonb` shape it stores. */
export type { JsonValue };
