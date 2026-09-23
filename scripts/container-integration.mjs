#!/usr/bin/env node
/**
 * Container integration test (Phase 6 §70).
 *
 * Builds the real images with the real Dockerfiles and runs the real production
 * composition — reverse proxy, web, API, MCP, PostgreSQL — then proves the one
 * property the mission cares about most: **the API and the MCP service read and
 * write the same project**.
 *
 *   MCP creates a resource  → the API reads it immediately
 *   the API creates one     → the MCP reads it immediately
 *
 * The fixture identity is seeded by direct SQL, because a container has no
 * identity provider. The credential is hashed with the deployment's own
 * `TOKEN_PEPPER` and the same HMAC-SHA-256 construction the server uses, so the
 * seeded token is indistinguishable from a minted one.
 *
 * Usage: node scripts/container-integration.mjs
 */
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const COMPOSE = ["compose", "-f", "compose.production.yml"];
const PROJECT = "sdm-phase6-it";
const PROXY_PORT = process.env.IT_PROXY_PORT ?? "18080";
const API_PUBLIC_URL = `http://localhost:${PROXY_PORT}`;
const MCP_PUBLIC_URL = `http://localhost:${PROXY_PORT}`;
const TOKEN_PEPPER = "integration-token-pepper-0123456789abcdef";
const COOKIE_SECRET = "integration-cookie-secret-0123456789abcdef";
const POSTGRES_PASSWORD = "integration-password";

/** Run a command, inheriting stdio, and fail loudly on a non-zero exit. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout}${result.stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail}`);
  }
  return result.stdout ?? "";
}

/** Compose with the environment this run needs. */
function compose(args, options = {}) {
  return run("docker", [...COMPOSE, ...args], {
    ...options,
    env: {
      COMPOSE_PROJECT_NAME: PROJECT,
      PROXY_PORT,
      API_PUBLIC_URL,
      MCP_PUBLIC_URL,
      POSTGRES_PASSWORD,
      COOKIE_SECRET,
      TOKEN_PEPPER,
      OIDC_ISSUER: "https://idp.invalid/realms/it",
      OIDC_CLIENT_ID: "sequencediagrams",
      OIDC_CLIENT_SECRET: "integration-oidc-secret",
      ...options.env,
    },
  });
}

/** Poll a URL until it answers, or throw after the deadline. */
async function waitFor(url, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(1_000);
  }
  throw new Error(`${label} did not become ready (${lastError})`);
}

/** Run SQL in the postgres container and return the rows as text. */
function sql(statement) {
  return compose(
    [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "sdm",
      "-d",
      "sdm",
      "-t",
      "-A",
      "-c",
      statement,
    ],
    { capture: true },
  ).trim();
}

/** Seed a user, agent and credential, and return the plaintext token. */
function seedCredential() {
  const userId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const prefix = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const token = `sdm_pat_${prefix}.${secret}`;
  const hash = createHmac("sha256", TOKEN_PEPPER)
    .update(token, "utf8")
    .digest("hex");

  sql(
    `INSERT INTO users (id, display_name, email)
     VALUES ('${userId}', 'Integration', NULL);`,
  );
  sql(
    `INSERT INTO user_identities (user_id, issuer, subject)
     VALUES ('${userId}', 'https://idp.invalid/realms/it', 'integration');`,
  );
  sql(
    `INSERT INTO workspaces (id, owner_id, name, is_default)
     VALUES ('${userId}', '${userId}', 'Integration Workspace', true);`,
  );
  sql(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ('${userId}', '${userId}', 'ADMIN');`,
  );
  sql(
    `INSERT INTO projects (id, owner_id, workspace_id, name, slug)
     VALUES ('${projectId}', '${userId}', '${userId}', 'Integration Project', 'integration-project');`,
  );
  sql(
    `INSERT INTO project_members (project_id, user_id, role)
     VALUES ('${projectId}', '${userId}', 'OWNER');`,
  );
  sql(
    `INSERT INTO agent_identities (id, owner_user_id, name)
     VALUES ('${agentId}', '${userId}', 'Integration agent');`,
  );
  sql(
    `INSERT INTO agent_credentials (id, agent_id, name, token_prefix, token_hash, scopes)
     VALUES ('${credentialId}', '${agentId}', 'Integration credential', '${prefix}', '${hash}',
             ARRAY['project:read','resource:read','diagram:render','project:search','project:validate','resource:write']);`,
  );
  return { token, projectId, userId, credentialId };
}

/** Call an API route with the PAT. */
async function api(token, path, init = {}) {
  return fetch(`${API_PUBLIC_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/** Call an MCP tool and return its structured content. */
async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(
      `MCP tool ${name} failed: ${JSON.stringify(result.structuredContent)}`,
    );
  }
  return result.structuredContent;
}

async function main() {
  process.stdout.write("Building and starting the production composition…\n");
  compose(["up", "-d", "--build"]);

  try {
    await waitFor(`${API_PUBLIC_URL}/healthz`, "the API");
    await waitFor(`${MCP_PUBLIC_URL}/health`, "the MCP service");

    const { token, projectId } = seedCredential();

    // ---- MCP writes, the API reads ------------------------------------------
    const client = new Client({ name: "container-it", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${MCP_PUBLIC_URL}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    await callTool(client, "create_resource", {
      projectId,
      path: "from-mcp.seq",
      type: "sequence-diagram",
      content: "title From MCP\n",
    });

    const listed = await api(token, `/api/projects/${projectId}/resources`);
    if (!listed.ok) {
      throw new Error(`the API could not list resources: ${listed.status}`);
    }
    const fromMcp = (await listed.json()).resources.find(
      (resource) => resource.path === "from-mcp.seq",
    );
    if (!fromMcp) {
      throw new Error(
        "a resource created through MCP is not visible to the API",
      );
    }

    const readBack = await api(
      token,
      `/api/projects/${projectId}/resources/${fromMcp.id}`,
    );
    const body = await readBack.json();
    if (body.content !== "title From MCP\n") {
      throw new Error(
        `the API read different content: ${JSON.stringify(body)}`,
      );
    }
    process.stdout.write("✓ MCP → API consistency\n");

    // ---- The API writes, MCP reads ------------------------------------------
    const created = await api(token, `/api/projects/${projectId}/resources`, {
      method: "POST",
      body: JSON.stringify({
        path: "from-api.seq",
        type: "sequence-diagram",
        content: "title From API\n",
      }),
    });
    if (created.status !== 201) {
      throw new Error(`the API could not create a resource: ${created.status}`);
    }

    const seen = await callTool(client, "read_resource", {
      projectId,
      resource: "from-api.seq",
    });
    if (seen.content !== "title From API\n") {
      throw new Error(`MCP read different content: ${JSON.stringify(seen)}`);
    }
    process.stdout.write("✓ API → MCP consistency\n");

    // ---- The revision contract holds across both hosts ----------------------
    const viaApi = await api(
      token,
      `/api/projects/${projectId}/resources/${fromMcp.id}`,
    );
    const current = (await viaApi.json()).resource.revision;
    const update = await callTool(client, "update_resource", {
      projectId,
      resource: "from-mcp.seq",
      content: "title Updated by MCP\n",
      expectedRevision: current,
    });
    if (update.resource.revision !== current + 1) {
      throw new Error("the revision did not advance as expected");
    }
    const stale = await api(
      token,
      `/api/projects/${projectId}/resources/${fromMcp.id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          content: "title Stale\n",
          expectedRevision: current,
        }),
      },
    );
    if (stale.status !== 409) {
      throw new Error(`a stale API write was not refused: ${stale.status}`);
    }
    process.stdout.write("✓ cross-host revision conflict\n");

    await client.close();

    // ---- The MCP image contains no frontend and no nginx -------------------
    const listing = run(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        "software-docs-mcp:phase6",
        "-c",
        "ls -1 /app && (which nginx || echo no-nginx) && (ls /app/dist 2>/dev/null || echo no-dist)",
      ],
      { capture: true },
    );
    if (/index\.html/.test(listing)) {
      throw new Error("the MCP image contains a frontend bundle");
    }
    if (!/no-nginx/.test(listing)) {
      throw new Error("the MCP image contains nginx");
    }
    process.stdout.write("✓ the MCP image is MCP-only\n");

    process.stdout.write("\nCONTAINER INTEGRATION PASSED\n");
  } finally {
    compose(["down", "-v", "--remove-orphans"]);
  }
}

main().catch((error) => {
  process.stderr.write(`\nCONTAINER INTEGRATION FAILED\n${error.message}\n`);
  process.exitCode = 1;
});
