/**
 * Bundle the MCP server into a single runnable file.
 *
 * The server is written in TypeScript against the same source tree the browser
 * app uses, but a client launches it as a plain Node process, so it has to be
 * compiled and its extensionless `bundler`-style imports resolved. esbuild does
 * both in one pass and produces one self-contained ESM file with no runtime
 * dependencies — which is what makes the documented client config a single
 * `node dist-mcp/server.mjs` command.
 *
 * Usage: node scripts/build-mcp.mjs
 */
import { chmod, rm, stat } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "dist-mcp";
const outfile = `${outdir}/server.mjs`;

// A stale bundle from an earlier revision is worse than no bundle, so the
// output directory is rebuilt from scratch every time.
await rm(outdir, { recursive: true, force: true });

await build({
  entryPoints: ["mcp/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  // Node 20 is the oldest runtime in CI and the Dockerfile, so the bundle
  // avoids newer syntax features rather than relying on a newer Node.
  target: "node20",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  banner: { js: "#!/usr/bin/env node" },
});

// `npm link` (and the package `bin` entry) expects the file to be executable.
await chmod(outfile, 0o755);

const { size } = await stat(outfile);
const kib = (size / 1024).toFixed(1);
process.stdout.write(`Built ${outfile} (${kib} KiB)\n`);
