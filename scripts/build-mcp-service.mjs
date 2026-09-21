/**
 * Bundle the MCP service into a single runnable file.
 *
 * Same reasoning as the API bundle: a container copies one artifact, starts it
 * with `node`, and needs no build toolchain or `node_modules` layer at runtime.
 * The difference from `build-mcp.mjs` is which host is being built — this one is
 * the *service* (`apps/mcp`), with its own HTTP listener, not the stdio tool.
 *
 * Usage: node scripts/build-mcp-service.mjs
 */
import { chmod, rm, stat } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "dist-mcp-service";
const outfile = `${outdir}/server.mjs`;

// A stale bundle from an earlier revision is worse than no bundle.
await rm(outdir, { recursive: true, force: true });

await build({
  entryPoints: ["apps/mcp/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  // `pg` discovers optional native bindings at runtime, and PGlite ships a
  // runtime-loaded WebAssembly build that cannot be inlined. Both stay external
  // for the same reasons the API bundle leaves them external: PGlite is a test
  // driver and `pg-native` is an optional accelerator.
  external: ["pg-native", "@electric-sql/pglite"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

await chmod(outfile, 0o755);

const { size } = await stat(outfile);
process.stdout.write(`Built ${outfile} (${(size / 1024).toFixed(1)} KiB)\n`);
