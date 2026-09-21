/**
 * CLI entry point for the MCP server.
 *
 * Kept apart from `server.ts` so the dispatch logic can be imported and unit
 * tested without a process or a transport. This file owns argument parsing,
 * startup validation, and the one thing a stdio server must never get wrong:
 * stdout carries MCP messages only, so usage and errors go to stderr.
 *
 * Usage:
 *   node dist-mcp/server.mjs [--workspace <dir>] [--project <name>]
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LATEST_PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  runStdioServer,
} from "./server";

/** The parsed command line. */
export interface CliOptions {
  workspace?: string;
  project?: string;
  help: boolean;
  version: boolean;
}

/** The usage text. */
export const USAGE = `Usage: ${SERVER_NAME}-mcp [workspace] [options]

An MCP server (stdio) that lets an agent document an application: sequence
diagrams, event flows, and the markdown that ties them together. The workspace
is a directory whose subdirectories are projects, exactly like a folder opened
in the SequenceDiagrams app.

Arguments:
  [workspace]              Workspace directory (default: the current directory)

Options:
  -w, --workspace <dir>    Workspace directory
  -p, --project <name>     Default project for tool calls that omit one
  -h, --help               Show this help
  -V, --version            Show the version

Examples:
  node dist-mcp/server.mjs --workspace ./docs
  node dist-mcp/server.mjs -w ./docs -p Payments

Protocol revision: ${LATEST_PROTOCOL_VERSION} (with the initialize handshake
supported for earlier clients).
`;

/** Parse argv (without the node/script prefix). */
export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = { help: false, version: false };
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-V":
      case "--version":
        options.version = true;
        break;
      case "-w":
      case "--workspace": {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new Error(`${arg} requires a directory`);
        }
        options.workspace = value;
        index += 1;
        break;
      }
      case "-p":
      case "--project": {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new Error(`${arg} requires a project name`);
        }
        options.project = value;
        index += 1;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positional.push(arg);
        break;
    }
  }

  // A bare first argument is the workspace, so `server.mjs ./docs` works as
  // well as the flag form.
  if (options.workspace === undefined && positional.length > 0) {
    options.workspace = positional.shift();
  }
  if (positional.length > 0) {
    throw new Error(`Unexpected argument: ${positional.join(" ")}`);
  }
  return options;
}

/** Resolve and validate the workspace directory. */
async function resolveWorkspace(workspace: string): Promise<string> {
  const resolved = path.resolve(workspace);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(
      `Workspace directory does not exist: ${resolved}. Create it, or point --workspace at an existing documentation folder.`,
    );
  }
  if (!info.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${resolved}`);
  }
  return resolved;
}

/** Run the CLI. Returns a process exit code. */
export async function main(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliOptions(argv);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return 1;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return 0;
  }

  try {
    const workspace = await resolveWorkspace(options.workspace ?? ".");
    // Diagnostics belong on stderr: stdout is the MCP channel.
    process.stderr.write(
      `[${SERVER_NAME}] workspace ${workspace}${
        options.project === undefined ? "" : `, project ${options.project}`
      }\n`,
    );
    await runStdioServer({
      workspaceRoot: workspace,
      defaultProject: options.project,
    });
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

// Only run when executed as a program, never when imported by a test.
const entry = process.argv[1];
if (
  entry !== undefined &&
  path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
