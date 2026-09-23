/**
 * The shared server runtime for the API and remote MCP hosts.
 *
 * The HTTP API and the MCP service are separate *processes* with separate
 * images, separate configuration and separate failure domains — but they are not
 * separate applications. They open the same database, mount the same project
 * volume and run the same use cases. This module is the wiring they share, so
 * building a second host is a composition root and not a second persistence
 * stack.
 *
 * What it deliberately does not do: read `process.env`, open a network listener,
 * or know what an HTTP request is. Each host loads its own configuration, calls
 * {@link createServerRuntime}, and adds the transport-specific pieces on top.
 *
 * ## Recovery at boot
 *
 * A process that starts also finishes what a previous process left half-done.
 * {@link createServerRuntime} does not run recovery itself — a host may want to
 * log or fail on it — but {@link recoverServerRuntime} is the one call that
 * drives every unfinished workspace operation to a consistent state.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { migrate } from "./migrate";
import { createPostgresClient, type PostgresOptions } from "./postgres-client";
import { createPgliteClient, type PgliteOptions } from "./pglite-client";
import { createUserRepository } from "./user-repository";
import { createProjectRepository } from "./project-repository";
import { createWorkspaceRepository } from "./workspace-repository";
import { createSessionRepository } from "./session-repository";
import { createAuditRepository } from "./audit-repository";
import {
  createAgentCredentialRepository,
  createAgentIdentityRepository,
} from "./agent-repository";
import { createWorkspaceOperationRepository } from "./workspace-operation-repository";
import {
  createWorkspaceMutationService,
  type WorkspaceMutationService,
} from "../application/workspace-mutations";
import type { WorkspaceOperationRepository } from "../application/ports/workspace-operation-repository";
import {
  assertProjectVolumeUsable,
  createFsProjectStorage,
} from "./fs-project-storage";
import type { SqlClient } from "./sql-client";

/** The configuration the shared runtime needs. */
export interface ServerRuntimeConfig {
  database: PostgresOptions | PgliteOptions;
  /** The directory holding every project's storage directory. */
  projectVolume: string;
  /**
   * The HMAC pepper credential digests are keyed with.
   *
   * This is required separately from the cookie secret because the two
   * credentials serve different purposes. Each host's configuration loader is
   * responsible for refusing to start without it.
   */
  tokenPepper: string;
  /**
   * Observability hooks a host may supply for the mutation path.
   *
   * The application layer does not import a metrics library, so it reports
   * through callbacks a host wires to its own counters. A host that omits them
   * simply records nothing, which is why they are optional rather than required.
   */
  onMutationFailure?: (reason: string) => void;
  onCompensation?: (reason: string) => void;
}

/** Everything shared by the API and MCP hosts, built once per process. */
export interface ServerRuntime {
  sql: SqlClient;
  users: ReturnType<typeof createUserRepository>;
  projects: ReturnType<typeof createProjectRepository>;
  workspaces: ReturnType<typeof createWorkspaceRepository>;
  sessions: ReturnType<typeof createSessionRepository>;
  audit: ReturnType<typeof createAuditRepository>;
  agentIdentities: ReturnType<typeof createAgentIdentityRepository>;
  credentials: ReturnType<typeof createAgentCredentialRepository>;
  operations: WorkspaceOperationRepository;
  /** The one authoritative resource-mutation path. */
  mutations: WorkspaceMutationService;
  /** The HMAC pepper credential digests are keyed with. Never sent anywhere. */
  tokenPepper: string;
  /** A project's content store. The id must already be authorized. */
  storageFor: (projectId: string) => ReturnType<typeof createFsProjectStorage>;
  /** A project's store and root directory together, for a provider. */
  locationFor: (projectId: string) => {
    storage: ReturnType<typeof createFsProjectStorage>;
    root: string;
  };
  /** Whether the database and the project volume are usable, for `/ready`. */
  ready: () => Promise<{ database: boolean; storage: boolean }>;
  /** Whether only the database answers, for `/health`'s cheap companion. */
  ping: () => Promise<boolean>;
}

/** SHA-256 of a document's text, used to verify a staged file on recovery. */
export function hashWorkspaceContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Open the SQL client a configuration describes.
 *
 * Asynchronous because the test driver is loaded lazily: a deployment that sets
 * `DATABASE_URL` must never even resolve the WebAssembly database module.
 */
export async function openDatabase(
  config: ServerRuntimeConfig,
): Promise<SqlClient> {
  if ("connectionString" in config.database) {
    return createPostgresClient(config.database);
  }
  return createPgliteClient(config.database);
}

/**
 * Build the shared runtime and bring the schema up to date.
 *
 * Migrating at boot is deliberate: a deployment that starts is a deployment
 * whose schema matches its code, and running the migrations twice is a no-op.
 */
export async function createServerRuntime(
  config: ServerRuntimeConfig,
): Promise<ServerRuntime> {
  const sql = await openDatabase(config);
  await migrate(sql);
  await assertProjectVolumeUsable(config.projectVolume);

  const projects = createProjectRepository(sql);
  const workspaces = createWorkspaceRepository(sql);
  const storageFor = (projectId: string) =>
    createFsProjectStorage({
      root: path.join(config.projectVolume, projectId),
    });
  const operations = createWorkspaceOperationRepository(sql);
  const mutations = createWorkspaceMutationService({
    projects,
    storage: storageFor,
    operations,
    hashContent: hashWorkspaceContent,
    ...(config.onMutationFailure === undefined
      ? {}
      : { onMutationFailure: config.onMutationFailure }),
    ...(config.onCompensation === undefined
      ? {}
      : { onCompensation: config.onCompensation }),
  });

  return {
    sql,
    users: createUserRepository(sql),
    projects,
    workspaces,
    sessions: createSessionRepository(sql),
    audit: createAuditRepository(sql),
    agentIdentities: createAgentIdentityRepository(sql),
    credentials: createAgentCredentialRepository(sql),
    operations,
    mutations,
    tokenPepper: config.tokenPepper,
    storageFor,
    locationFor: (projectId: string) => ({
      storage: storageFor(projectId),
      root: path.join(config.projectVolume, projectId),
    }),
    async ready() {
      const [database, storage] = await Promise.all([
        sql
          .query("SELECT 1")
          .then(() => true)
          .catch(() => false),
        assertProjectVolumeUsable(config.projectVolume)
          .then(() => true)
          .catch(() => false),
      ]);
      return { database, storage };
    },
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

/**
 * Finish every workspace operation a previous process left half-done.
 *
 * Called once at boot. A failure to recover is reported, not fatal: an operation
 * that cannot be classified is left for the next boot rather than crashing a
 * service that can still serve reads.
 */
export async function recoverServerRuntime(
  runtime: ServerRuntime,
  onError?: (error: unknown, operationId: string) => void,
): Promise<{ completed: number; failed: number; examined: number }> {
  const report = await runtime.mutations.recover(500);
  for (const failure of report.errors) {
    onError?.(new Error(failure.message), failure.operationId);
  }
  return {
    completed: report.completed,
    failed: report.failed,
    examined: report.examined,
  };
}

/** Close everything a runtime owns. */
export async function closeServerRuntime(
  runtime: ServerRuntime,
): Promise<void> {
  await runtime.sql.close().catch(() => {});
}
