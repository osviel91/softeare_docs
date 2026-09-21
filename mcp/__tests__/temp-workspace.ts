/**
 * Shared test helpers for the MCP suites.
 *
 * Every test that touches the filesystem gets its own directory under the OS
 * temp dir, so a suite never writes into the repository and two tests cannot see
 * each other's projects.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A throwaway workspace directory and the call that removes it. */
export interface TempWorkspace {
  root: string;
  cleanup(): Promise<void>;
}

/** Create an empty workspace directory in the OS temp dir. */
export async function makeTempWorkspace(): Promise<TempWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), "sd-mcp-"));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
