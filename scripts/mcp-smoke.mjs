#!/usr/bin/env node
/**
 * MCP server smoke test.
 *
 * The Vitest suites exercise the dispatch and workspace services in-process. This
 * script closes the remaining gap the way `e2e-smoke.mjs` does for the web app:
 * it spawns the *bundled* `dist-mcp/server.mjs` as a real stdio subprocess, speaks
 * newline-delimited JSON-RPC to it exactly as a client would, and writes real
 * documentation into a temporary workspace on disk.
 *
 * It checks the things a broken build or a bundling mistake would break:
 *
 *   1. the legacy `initialize` handshake and the modern `server/discover` probe;
 *   2. the full tool catalog is present and well formed;
 *   3. a create -> read -> validate -> audit loop writes real files;
 *   4. static reference resources and prompts resolve;
 *   5. protocol errors and tool errors are reported in the right channel.
 *
 * Usage: `npm run test:mcp` (builds first).
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "dist-mcp", "server.mjs");
const REQUEST_TIMEOUT_MS = 10_000;

const failures = [];

/** Record and print one assertion result. */
function check(description, passed, detail = "") {
  const status = passed ? "PASS" : "FAIL";
  console.log(
    `  [${status}] ${description}${detail === "" ? "" : ` — ${detail}`}`,
  );
  if (!passed) failures.push(description);
}

/** A tiny JSON-RPC client over a subprocess's stdio. */
function connect(child) {
  const pending = new Map();
  let buffer = "";
  let nextId = 1;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      const settle = pending.get(message.id);
      if (!settle) continue;
      pending.delete(message.id);
      settle(message);
    }
  });

  return {
    /** Send a request and resolve with its response. */
    request(method, params) {
      const id = nextId++;
      const message = {
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timed out waiting for ${method}`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
    /** Send a notification (no response expected). */
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
  };
}

/** Call a tool and require a non-error result. */
async function callTool(client, name, args) {
  const response = await client.request("tools/call", {
    name,
    arguments: args,
  });
  if (response.error) {
    throw new Error(`${name} failed: ${response.error.message}`);
  }
  return response.result;
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), "sd-mcp-smoke-"));
  const child = spawn(process.execPath, [SERVER, "--workspace", workspace], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const client = connect(child);

  try {
    // --- lifecycle ---------------------------------------------------------
    const initialize = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-smoke", version: "1.0.0" },
    });
    check(
      "initialize negotiates the legacy protocol version",
      initialize.result?.protocolVersion === "2025-06-18",
      String(initialize.result?.protocolVersion),
    );
    const capabilities = initialize.result?.capabilities ?? {};
    check(
      "initialize advertises tools, resources and prompts",
      "tools" in capabilities &&
        "resources" in capabilities &&
        "prompts" in capabilities,
    );
    check(
      "initialize carries model instructions",
      typeof initialize.result?.instructions === "string" &&
        initialize.result.instructions.includes("validate_source"),
    );
    client.notify("notifications/initialized");

    const discover = await client.request("server/discover", {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    });
    check(
      "server/discover reports the modern revision",
      discover.result?.supportedVersions?.includes("2026-07-28") === true,
    );
    check(
      "server/discover result is marked complete",
      discover.result?.resultType === "complete",
    );

    // --- catalog -----------------------------------------------------------
    const tools = await client.request("tools/list");
    const names = (tools.result?.tools ?? []).map((tool) => tool.name);
    check(
      "tools/list returns the full catalog",
      names.length === 23,
      `${names.length} tools`,
    );
    check(
      "every tool carries a schema and annotations",
      (tools.result?.tools ?? []).every(
        (tool) =>
          tool.inputSchema?.type === "object" &&
          typeof tool.annotations?.readOnlyHint === "boolean" &&
          String(tool.description).length > 80,
      ),
    );

    const resources = await client.request("resources/list");
    check(
      "resources/list advertises the DSL references and guides",
      (resources.result?.resources ?? []).length === 6,
    );

    const sequenceRef = await client.request("resources/read", {
      uri: "sequencediagrams://reference/sequence-dsl",
    });
    check(
      "the sequence DSL reference is readable",
      sequenceRef.result?.contents?.[0]?.text?.includes("### Participant") ===
        true,
    );

    const prompt = await client.request("prompts/get", {
      name: "document-application",
      arguments: { project: "Payments", system: "the checkout service" },
    });
    check(
      "prompts/get resolves a prompt with its arguments",
      prompt.result?.messages?.[0]?.content?.text?.includes(
        "the checkout service",
      ) === true,
    );

    // --- a real workflow on disk -------------------------------------------
    const project = await callTool(client, "create_project", {
      name: "Payments",
    });
    check(
      "create_project reports the new project",
      project.isError === false && project.structuredContent?.id === "Payments",
    );

    const created = await callTool(client, "create_resource", {
      project: "Payments",
      kind: "diagram",
      name: "checkout",
      title: "Checkout",
      content:
        "actor Customer\nparticipant API\nCustomer ->> API: Pay\nAPI -->> Customer: Paid\n",
    });
    check(
      "create_resource writes a diagram with a stable id",
      created.structuredContent?.resource?.id === "diagram-checkout" &&
        created.structuredContent?.resource?.path === "checkout.seq",
      String(created.structuredContent?.resource?.path),
    );

    const read = await callTool(client, "read_resource", {
      project: "Payments",
      resource: "diagram-checkout",
    });
    check(
      "read_resource returns the written source",
      read.content?.[0]?.text?.includes("participant API") === true,
    );

    const validation = await callTool(client, "validate_project", {
      project: "Payments",
    });
    check(
      "validate_project reports a clean document",
      validation.content?.[0]?.text?.includes("0 errors") === true,
      validation.content?.[0]?.text?.split("\n")[0],
    );

    const audit = await callTool(client, "audit_documentation", {
      project: "Payments",
    });
    check(
      "audit_documentation returns structured findings",
      Array.isArray(audit.structuredContent?.findings) &&
        audit.structuredContent?.summary?.resources === 1,
    );

    const rendered = await callTool(client, "render_diagram", {
      project: "Payments",
      resource: "checkout",
    });
    check(
      "render_diagram produces SVG",
      rendered.structuredContent?.svg?.includes("<svg") === true,
    );

    const metadata = JSON.parse(
      await readFile(join(workspace, "Payments", "project.json"), "utf8"),
    );
    check(
      "the project identity record was written to disk",
      metadata.resources?.some((record) => record.id === "diagram-checkout") ===
        true,
    );

    const templateRead = await client.request("resources/read", {
      uri: "sequencediagrams://project/Payments/resource/checkout.seq",
    });
    check(
      "the project resource URI template reads a document",
      templateRead.result?.contents?.[0]?.text?.includes("Customer ->> API") ===
        true,
    );

    // --- error channels ----------------------------------------------------
    const unknownTool = await client.request("tools/call", {
      name: "not_a_tool",
      arguments: {},
    });
    check(
      "an unknown tool is a JSON-RPC error",
      unknownTool.error?.code === -32602,
      String(unknownTool.error?.code),
    );

    const unconfirmed = await callTool(client, "delete_resource", {
      project: "Payments",
      resource: "checkout",
      confirm: false,
    });
    check(
      "an unconfirmed delete is a tool error, not a deletion",
      unconfirmed.isError === true &&
        unconfirmed.content?.[0]?.text?.includes("confirmation") === true,
    );

    const unsupported = await client.request("tools/list", {
      _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
    });
    check(
      "an unsupported protocol version returns -32022",
      unsupported.error?.code === -32022,
      String(unsupported.error?.code),
    );
  } finally {
    child.stdin.end();
    await exited;
    await rm(workspace, { recursive: true, force: true });
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`MCP smoke test FAILED (${failures.length} check(s))`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("MCP smoke test passed.");
}

main().catch((error) => {
  console.error(`\nMCP smoke test could not run: ${error.message}`);
  process.exitCode = 1;
});
