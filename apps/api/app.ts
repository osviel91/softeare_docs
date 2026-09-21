/**
 * The API's composition root (ADR-040).
 *
 * One place builds the persistence layer from the configuration and hands it to
 * the route table as plain values. No module below this one reads a global, opens
 * a connection lazily, or resolves a dependency by import side effect — which is
 * what lets a test build the whole API against an in-memory PostgreSQL and call
 * `handle()` on it.
 */
import path from "node:path";
import { migrate } from "../../src/persistence/migrate";
import { createPostgresClient } from "../../src/persistence/postgres-client";
import { createPgliteClient } from "../../src/persistence/pglite-client";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createSessionRepository } from "../../src/persistence/session-repository";
import { createAuditRepository } from "../../src/persistence/audit-repository";
import { createPersonalAccessTokenRepository } from "../../src/persistence/personal-access-token-repository";
import type { SqlClient } from "../../src/persistence/sql-client";
import {
  createProjectCatalog,
  type ProjectCatalog,
} from "../../src/application/project-catalog";
import { createPersonalAccessTokenService } from "../../src/application/personal-access-token-service";
import { generatePat } from "./auth/pat";
import {
  assertProjectVolumeUsable,
  createFsProjectStorage,
} from "../../src/persistence/fs-project-storage";
import type { ServerConfig } from "./config";

/** Everything the route table needs, built once per process. */
export interface AppDependencies {
  config: ServerConfig;
  sql: SqlClient;
  users: ReturnType<typeof createUserRepository>;
  projects: ReturnType<typeof createProjectRepository>;
  sessions: ReturnType<typeof createSessionRepository>;
  audit: ReturnType<typeof createAuditRepository>;
  /** Personal Access Tokens: the machine credentials remote MCP presents. */
  tokens: ReturnType<typeof createPersonalAccessTokenRepository>;
  /** The PAT lifecycle use cases the browser's token screen calls. */
  personalAccessTokens: ReturnType<typeof createPersonalAccessTokenService>;
  /**
   * A catalog over the same repositories.
   *
   * The catalog is stateless — the *caller* is the argument to each use case —
   * so one instance serves every request. It is still built per dependency set
   * rather than imported, so a test can hand in its own repositories.
   */
  catalog: ProjectCatalog;
  /** Where a project's files live. Never derived from a request. */
  storageFor: (projectId: string) => ReturnType<typeof createFsProjectStorage>;
  /**
   * A project's storage handle and its root directory together.
   *
   * The remote MCP workspace provider needs both for a project the catalog has
   * already authorized; building it here keeps the composition root the only
   * place that knows where the volume is.
   */
  locationFor: (projectId: string) => {
    storage: ReturnType<typeof createFsProjectStorage>;
    root: string;
  };
  /** Whether the database is reachable, for the health endpoint. */
  ping: () => Promise<boolean>;
}

/** Open the SQL client the configuration describes. */
export function openDatabase(config: ServerConfig): SqlClient {
  if ("connectionString" in config.database) {
    return createPostgresClient(config.database);
  }
  return createPgliteClient(config.database);
}

/**
 * Build the application's dependencies and bring the schema up to date.
 *
 * Migrating at boot is deliberate: a deployment that starts is a deployment
 * whose schema matches its code, and running the migrations twice is a no-op.
 */
export async function createApp(
  config: ServerConfig,
): Promise<AppDependencies> {
  const sql = openDatabase(config);
  await migrate(sql);
  await assertProjectVolumeUsable(config.projectVolume);

  const projects = createProjectRepository(sql);
  const storageFor = (projectId: string) =>
    createFsProjectStorage({
      root: path.join(config.projectVolume, projectId),
    });
  const audit = createAuditRepository(sql);
  const tokens = createPersonalAccessTokenRepository(sql);

  return {
    config,
    sql,
    users: createUserRepository(sql),
    projects,
    sessions: createSessionRepository(sql),
    audit,
    tokens,
    personalAccessTokens: createPersonalAccessTokenService({
      tokens,
      projects,
      audit,
      mint: generatePat,
    }),
    catalog: createProjectCatalog({ projects, audit, storage: storageFor }),
    storageFor,
    locationFor: (projectId: string) => ({
      storage: storageFor(projectId),
      root: path.join(config.projectVolume, projectId),
    }),
    async ping() {
      try {
        await sql.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Close everything a dependency set owns. */
export async function closeApp(dependencies: AppDependencies): Promise<void> {
  await dependencies.sql.close().catch(() => {});
}
