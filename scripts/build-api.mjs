/**
 * Bundle the API into a single runnable file.
 *
 * Same reasoning as the MCP bundle: a container copies one artifact, starts it
 * with `node`, and needs no build toolchain or `node_modules` layer at runtime.
 * The difference is that this bundle is not published — it is an application that
 * ships inside the API image — so the driver it uses (`pg`) is bundled with it
 * rather than resolved from the report's dependencies.
 *
 * Usage: node scripts/build-api.mjs
 */
import { chmod, rm, stat } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "dist-api";
const outfile = `${outdir}/server.mjs`;

// A stale bundle from an earlier revision is worse than no bundle.
await rm(outdir, { recursive: true, force: true });

await build({
  entryPoints: ["apps/api/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  // `pg` discovers optional native bindings at runtime; bundling it wholesale
  // keeps the container image dependency-free. It is written as CommonJS and
  // calls `require()` for Node built-ins, which an ESM bundle cannot do, so the
  // bundle gets a real `require` through `createRequire` — the standard shim,
  // rather than leaving `pg` to be resolved from a `node_modules` layer.
  // `pg-night` is an optional native binding, and PGlite ships a runtime-loaded
  // WebAssembly build that cannot be inlined: both stay external. PGlite is a
  // development and test driver, resolved from the workspace's `node_modules`,
  // and never used by a deployment that sets DATABASE_URL.
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
