/**
 * The API's composition root (ADR-040, Phase 6 §2).
 *
 * Phase 6 moved the persistence wiring into `src/persistence/server-runtime.ts`
 * so the API and the MCP service are two hosts over one application stack rather
 * than two stacks that happen to agree. What is left here is only what is
 * genuinely API-shaped: the server configuration, the agent lifecycle service,
 * the project catalog and the provider the documentation service opens projects
 * through.
 *
 * No module below this one reads a global or resolves a dependency by import
 * side effect, which is what lets a test build the whole API against an
 * in-memory PostgreSQL and call `handle()` on it.
 */
import {
  closeServerRuntime,
  createServerRuntime,
  openDatabase,
  recoverServerRuntime,
  type ServerRuntime,
} from "../../src/persistence/server-runtime";
import { createProjectCatalog } from "../../src/application/project-catalog";
import { createWorkspaceService } from "../../src/application/workspace-service";
import { createAgentService } from "../../src/application/agent-service";
import { createCredentialMint } from "./auth/agent-credential";
import type { ServerConfig } from "./config";

/** Everything the route table needs, built once per process. */
export interface AppDependencies {
  config: ServerConfig;
  /** The persistence, authorization and mutation stack shared with MCP. */
  runtime: ServerRuntime;
  sql: ServerRuntime["sql"];
  users: ServerRuntime["users"];
  projects: ServerRuntime["projects"];
  workspaces: ServerRuntime["workspaces"];
  sessions: ServerRuntime["sessions"];
  audit: ServerRuntime["audit"];
  /** Agent identities: the automation principals a user owns. */
  agentIdentities: ServerRuntime["agentIdentities"];
  /** Agent credentials: the revocable bearer secrets those agents present. */
  credentials: ServerRuntime["credentials"];
  /** The agent/credential lifecycle use cases the settings API calls. */
  agents: ReturnType<typeof createAgentService>;
  /** The HMAC pepper credential digests are keyed with. Never sent anywhere. */
  tokenPepper: string;
  /**
   * A catalog over the same repositories.
   *
   * The catalog is stateless — the *caller* is the argument to each use case —
   * so one instance serves every request.
   */
  catalog: ReturnType<typeof createProjectCatalog>;
  workspaceService: ReturnType<typeof createWorkspaceService>;
  /** Where a project's files live. Never derived from a request. */
  storageFor: ServerRuntime["storageFor"];
  /**
   * A project's storage handle and its root directory together.
   *
   * The remote MCP workspace provider needs both for a project the catalog has
   * already authorized; building it here keeps the composition root the only
   * place that knows where the volume is.
   */
  locationFor: ServerRuntime["locationFor"];
  /** Whether the database is reachable, for the health endpoint. */
  ping: () => Promise<boolean>;
  /** Whether the database *and* the project volume are usable, for `/ready`. */
  ready: ServerRuntime["ready"];
  /**
   * Whether this dependency set opened the runtime and therefore closes it.
   *
   * False when a host injected its own — an embedded host or the E2E harness
   * that builds both the API and the MCP over one database. Closing a runtime
   * the caller owns would pull the database out from under its second host.
   */
  ownsRuntime: boolean;
}

/** Options for {@link createApp}. */
export interface CreateAppOptions {
  /**
   * A runtime to use instead of opening one.
   *
   * This is the seam that lets one process run the API and the MCP service over
   * exactly the same repositories, which is what the browser↔MCP end-to-end
   * scenario needs and what an embedded host would want.
   */
  runtime?: ServerRuntime;
}

/** Open the SQL client the configuration describes. */
export { openDatabase };

/**
 * Build the application's dependencies and bring the schema up to date.
 */
export async function createApp(
  config: ServerConfig,
  options: CreateAppOptions = {},
): Promise<AppDependencies> {
  const ownsRuntime = options.runtime === undefined;
  const runtime =
    options.runtime ??
    (await createServerRuntime({
      database: config.database,
      projectVolume: config.projectVolume,
      tokenPepper: config.tokenPepper,
    }));

  const adminEmail = config.platformAdminEmail;
  if (adminEmail !== null) {
    const matching = (await runtime.users.list()).find(
      (user) => user.email?.toLowerCase() === adminEmail,
    );
    if (matching && (!matching.platformAdmin || matching.status !== "ACTIVE")) {
      await runtime.sql.query(
        "UPDATE users SET platform_admin = true, status = 'ACTIVE', updated_at = now() WHERE id = $1",
        [matching.id],
      );
    }
  }

  // A process that starts finishes what a previous one left half-done.
  await recoverServerRuntime(runtime, (error, operationId) => {
    process.stderr.write(
      `workspace recovery: ${operationId} could not be settled: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  });

  return {
    config,
    runtime,
    sql: runtime.sql,
    users: runtime.users,
    projects: runtime.projects,
    workspaces: runtime.workspaces,
    sessions: runtime.sessions,
    audit: runtime.audit,
    agentIdentities: runtime.agentIdentities,
    credentials: runtime.credentials,
    agents: createAgentService({
      agents: runtime.agentIdentities,
      credentials: runtime.credentials,
      projects: runtime.projects,
      audit: runtime.audit,
      mint: createCredentialMint(config.tokenPepper),
    }),
    tokenPepper: config.tokenPepper,
    // The catalog runs resource mutations through the *same* service the MCP
    // host uses, so there is one implementation of "update a resource".
    catalog: createProjectCatalog({
      projects: runtime.projects,
      audit: runtime.audit,
      storage: runtime.storageFor,
      mutations: runtime.mutations,
    }),
    workspaceService: createWorkspaceService(runtime.workspaces),
    storageFor: runtime.storageFor,
    locationFor: runtime.locationFor,
    ping: runtime.ping,
    ready: runtime.ready,
    ownsRuntime,
  };
}

/** Close everything a dependency set owns, and only what it owns. */
export async function closeApp(dependencies: AppDependencies): Promise<void> {
  if (!dependencies.ownsRuntime) return;
  await closeServerRuntime(dependencies.runtime);
}
