/**
 * The MCP service process (Phase 6 §3, §72).
 *
 * Startup is sequential and fail-fast: load and validate the configuration,
 * build the dependencies (which migrates the schema and recovers unfinished
 * work), listen, and install the shutdown handlers. A configuration problem
 * exits non-zero with a message and no stack — an operator should read it, not
 * decode it.
 *
 * Usage: node dist-mcp-service/server.mjs
 */
import { pathToFileURL } from "node:url";
import { loadMcpConfig, ConfigurationError } from "./config";
import { createMcpService } from "./app";
import { createMcpHttpServer } from "./http/node-server";

/**
 * The host's composition, re-exported for an embedding process.
 *
 * @see apps/api/main.ts for why: the E2E harness imports these to run the MCP
 * service in-process over the API's own runtime.
 */
export { loadMcpConfig, ConfigurationError };
export { createMcpService };
export { createMcpHttpServer };

/** Start the service, or exit with a readable message. */
export async function main(): Promise<void> {
  let config;
  try {
    config = loadMcpConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`Configuration error: ${error.message}\n`);
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    throw error;
  }

  const service = await createMcpService(config);
  const server = createMcpHttpServer({
    config,
    observability: service.observability,
    handleMcp: service.handleMcp,
    ready: service.ready,
    onError(error, requestId) {
      process.stderr.write(
        `${requestId} unhandled error: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }\n`,
      );
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });

  process.stdout.write(
    `sequencediagrams-mcp listening on ${config.publicUrl}${config.mcpPath} (${config.environment}), projects at ${config.projectVolume}\n`,
  );

  const shutdown = (signal: string) => {
    process.stdout.write(`${signal} received; shutting down.\n`);
    server.close(() => {
      void service.close().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only start when executed directly, so importing this module in a test never
// binds a port.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
