/**
 * The MCP service's composition root (Phase 6 §2, §25–26).
 *
 * The MCP service is a separate process with its own image, its own port and its
 * own configuration, but it is *not* a second application: it builds the same
 * {@link ServerRuntime} the API builds, runs the same project catalog, and
 * mutates resources through the same journaled mutation service. Nothing here
 * calls the API over HTTP; the two hosts meet in shared code, which is the
 * mission's item 26.
 */
import {
  closeServerRuntime,
  createServerRuntime,
  recoverServerRuntime,
  type ServerRuntime,
} from "../../src/persistence/server-runtime";
import { createProjectCatalog } from "../../src/application/project-catalog";
import type { McpConfig } from "./config";
import { createMcpAuthenticator, type McpAuthenticator } from "./auth/bearer";
import { ProcessRateLimiter, type RateLimiter } from "./rate-limit";
import {
  createJsonLogger,
  Metrics,
  type McpLogger,
  type Observability,
} from "./observability";
import { handleMcpRequest, type McpHandlerDeps } from "./mcp/handler";

/** Optional seams for a test or an embedding host. */
export interface McpServiceOptions {
  /** Where structured logs go. Defaults to one JSON line per event on stdout. */
  logger?: McpLogger;
  /**
   * A runtime to use instead of opening one.
   *
   * The seam that lets the MCP service and the API run over the same
   * repositories in one process — an embedded deployment, or the end-to-end
   * harness that has to prove a browser's write is visible to an agent.
   */
  runtime?: ServerRuntime;
}

/** Everything the MCP service owns, built once per process. */
export interface McpService {
  config: McpConfig;
  /** Whether this service opened the runtime and therefore closes it. */
  ownsRuntime: boolean;
  runtime: ServerRuntime;
  catalog: ReturnType<typeof createProjectCatalog>;
  authenticator: McpAuthenticator;
  limiter: RateLimiter;
  observability: Observability;
  handleMcp: (request: Request) => Promise<Response>;
  ready: () => Promise<{ database: boolean; storage: boolean }>;
  close: () => Promise<void>;
}

/**
 * Build the service, migrate and recover.
 *
 * Recovery runs at boot so a process that starts also finishes what a previous
 * process left half-done — the other half of the durable journal the API also
 * uses. A recovery failure is logged, not fatal: a service that can still serve
 * reads should not refuse to start because one operation could not be classified.
 */
export async function createMcpService(
  config: McpConfig,
  options: McpServiceOptions = {},
): Promise<McpService> {
  const ownsRuntime = options.runtime === undefined;
  const observability: Observability = {
    logger: options.logger ?? createJsonLogger(),
    metrics: new Metrics(),
  };

  const runtime =
    options.runtime ??
    (await createServerRuntime({
      database: config.database,
      projectVolume: config.projectVolume,
      tokenPepper: config.tokenPepper,
      onMutationFailure: (reason) =>
        observability.metrics.increment("workspace_mutation_failures_total", {
          reason,
        }),
      onCompensation: (reason) =>
        observability.metrics.increment("workspace_compensation_total", {
          reason,
        }),
    }));

  const catalog = createProjectCatalog({
    projects: runtime.projects,
    audit: runtime.audit,
    storage: runtime.storageFor,
    mutations: runtime.mutations,
  });

  const deps: McpHandlerDeps = {
    config,
    catalog,
    authenticator: createMcpAuthenticator({
      credentials: runtime.credentials,
      pepper: runtime.tokenPepper,
    }),
    limiter: new ProcessRateLimiter(config.rateLimits),
    observability,
  };

  await recoverServerRuntime(runtime, (error, operationId) => {
    observability.logger.log({
      event: "workspace.recovery.failed",
      level: "warn",
      result: "failed",
      message: `${operationId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    observability.metrics.increment("workspace_mutation_failures_total", {
      reason: "recovery",
    });
  });

  observability.logger.log({
    event: "mcp.service.started",
    result: "success",
    message: `database connected, projects at ${config.projectVolume}`,
  });

  return {
    config,
    runtime,
    ownsRuntime,
    catalog,
    authenticator: deps.authenticator,
    limiter: deps.limiter,
    observability,
    handleMcp: (request) => handleMcpRequest(request, deps),
    ready: runtime.ready,
    async close() {
      // A runtime the caller owns is left to the caller: closing it here would
      // pull the database out from under the other host sharing it.
      if (!ownsRuntime) return;
      await closeServerRuntime(runtime);
    },
  };
}
