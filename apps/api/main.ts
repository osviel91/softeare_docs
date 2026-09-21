/**
 * The API process.
 *
 * Startup is sequential and fail-fast: load and validate the configuration,
 * build the dependencies (which migrates the schema), listen, and install the
 * shutdown handlers. A configuration problem exits non-zero with a message and no
 * stack — an operator should read it, not decode it.
 *
 * Usage: node dist-api/server.mjs
 */
import { pathToFileURL } from "node:url";
import { loadConfig, ConfigurationError } from "./config";
import { closeApp, createApp } from "./app";
import { createRouter } from "./routes";
import { createHttpServer } from "./http/node-server";

/** Start the server, or exit with a readable message. */
export async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`Configuration error: ${error.message}\n`);
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    throw error;
  }

  const dependencies = await createApp(config);
  const server = createHttpServer({
    router: createRouter(dependencies),
    onError(error, requestId) {
      // The correlation id is the only thing that ties a 500 to its cause.
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
    `sequencediagrams-api listening on ${config.publicUrl} (${config.environment}), database connected, projects at ${config.projectVolume}\n`,
  );

  const shutdown = (signal: string) => {
    process.stdout.write(`${signal} received; shutting down.\n`);
    server.close(() => {
      void closeApp(dependencies).finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only start when executed directly, so importing this module in a test never
// binds a port. Resolving both sides through `pathToFileURL` means the same
// check works for the TypeScript entry, its test runner and the bundled file.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
