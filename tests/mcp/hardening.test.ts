/**
 * Authentication, authorization, protocol-hardening and statelessness
 * (Phase 6 §52, §64–67, §9, §34–37).
 *
 * These tests talk raw HTTP to the service rather than through the client SDK,
 * because their subject *is* the HTTP boundary: a status code, a challenge
 * header, a `Mcp-Method` that disagrees with the body, a body over the limit, a
 * rate limit that has run out.
 */
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHarness, type McpHarness } from "./harness";

/** A POST to the MCP endpoint with a JSON-RPC body. */
async function post(
  origin: string,
  body: unknown,
  options: {
    token?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...options.headers,
  };
  if (options.token !== null && options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  return fetch(`${origin}/mcp`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A JSON-RPC tools/call body. */
function call(tool: string, args: Record<string, unknown>): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  };
}

describe("authentication", () => {
  let harness: McpHarness;
  let ownerId: string;

  beforeAll(async () => {
    harness = await startHarness();
    ownerId = await harness.aUser();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("refuses a request with no Authorization header", async () => {
    const response = await post(
      harness.origin,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: null },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(response.headers.get("www-authenticate")).toContain(
      harness.config.publicUrl,
    );
    const body = (await response.json()) as any;
    expect(body.error.code).toBe("unauthorized");
  });

  it("refuses a malformed token with 401", async () => {
    const response = await post(
      harness.origin,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: "not-a-token" },
    );
    expect(response.status).toBe(401);
  });

  it("refuses a browser session cookie as authentication", async () => {
    const response = await post(
      harness.origin,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      {
        token: null,
        headers: {
          cookie:
            "sdm_session=sid_00000000-0000-7000-8000-000000000000.abcdefghijklmnopqrst",
        },
      },
    );
    expect(response.status).toBe(401);
  });

  it("refuses an expired credential with 401", async () => {
    const { token, credentialId } = await harness.aToken(ownerId);
    await harness.service.runtime.sql.query(
      "UPDATE agent_credentials SET expires_at = now() - interval '1 hour' WHERE id = $1",
      [credentialId],
    );
    const response = await post(
      harness.origin,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token },
    );
    expect(response.status).toBe(401);
  });

  it("refuses a revoked credential with 401", async () => {
    const { token, credentialId } = await harness.aToken(ownerId);
    await harness.service.runtime.sql.query(
      "UPDATE agent_credentials SET revoked_at = now() WHERE id = $1",
      [credentialId],
    );
    const response = await post(
      harness.origin,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token },
    );
    expect(response.status).toBe(401);
  });

  it("refuses a credential whose agent is disabled with 401", async () => {
    const { token, agentId } = await harness.aToken(ownerId);
    await harness.service.runtime.sql.query(
      "UPDATE agent_identities SET disabled_at = now() WHERE id = $1",
      [agentId],
    );
    const response = await post(
      harness.origin,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token },
    );
    expect(response.status).toBe(401);
  });

  it("accepts a valid credential", async () => {
    const { token } = await harness.aToken(ownerId);
    const response = await post(
      harness.origin,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(Array.isArray(body.result.tools)).toBe(true);
  });
});

describe("authorization", () => {
  let harness: McpHarness;
  let ownerId: string;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    harness = await startHarness();
    ownerId = await harness.aUser();
    projectA = await harness.aProject(ownerId, "Project A");
    projectB = await harness.aProject(ownerId, "Project B");
  });

  afterAll(async () => {
    await harness.close();
  });

  it("advertises no write tools to a read-only credential", async () => {
    const { token } = await harness.aToken(ownerId, [
      "project:read",
      "resource:read",
    ]);
    const response = await post(
      harness.origin,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token },
    );
    const body = (await response.json()) as any;
    const names = body.result.tools.map((tool: any) => tool.name);
    expect(names).toContain("list_resources");
    expect(names).not.toContain("update_resource");
    expect(names).not.toContain("delete_resource");
  });

  it("refuses a write a read-only credential calls by name", async () => {
    const { token } = await harness.aToken(ownerId, [
      "project:read",
      "resource:read",
    ]);
    const response = await post(
      harness.origin,
      call("create_resource", {
        projectId: projectA,
        path: "sneaky.seq",
        type: "sequence-diagram",
        content: "",
      }),
      { token },
    );
    const body = (await response.json()) as any;
    // The tool is disabled for this credential, so the refusal is a tool error
    // rather than an unknown-tool protocol error.
    expect(body.result.isError).toBe(true);
  });

  it("hides a project a restricted credential is not allowed to see", async () => {
    const { token } = await harness.aToken(
      ownerId,
      ["project:read", "resource:read"],
      [projectA],
    );
    const listed = await post(harness.origin, call("list_projects", {}), {
      token,
    });
    const body = (await listed.json()) as any;
    const ids = body.result.structuredContent.projects.map(
      (project: any) => project.id,
    );
    expect(ids).toContain(projectA);
    expect(ids).not.toContain(projectB);

    const addressed = await post(
      harness.origin,
      call("list_resources", { projectId: projectB }),
      { token },
    );
    const addressedBody = (await addressed.json()) as any;
    expect(addressedBody.result.isError).toBe(true);
    // Invisible, not forbidden: the same answer a project that does not exist gets.
    expect(addressedBody.result.structuredContent.error.code).toBe("not_found");
  });

  it("refuses a write for a VIEWER even with a write-enabled credential", async () => {
    const viewerId = await harness.aUser("Viewer");
    await harness.service.runtime.projects.setMember(
      projectA,
      viewerId,
      "VIEWER",
    );
    const { token } = await harness.aToken(
      viewerId,
      ["project:read", "resource:read", "resource:write"],
      [projectA],
    );
    const response = await post(
      harness.origin,
      call("create_resource", {
        projectId: projectA,
        path: "viewer.seq",
        type: "sequence-diagram",
        content: "",
      }),
      { token },
    );
    const body = (await response.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error.code).toBe("forbidden");
  });
});

describe("protocol hardening", () => {
  let harness: McpHarness;
  let ownerId: string;
  let projectId: string;
  let token: string;

  beforeAll(async () => {
    harness = await startHarness({
      env: {
        MCP_RATE_READ_LIMIT: "3",
        MCP_RATE_WRITE_LIMIT: "1",
        MCP_MAX_BODY_BYTES: "400",
      },
    });
    ownerId = await harness.aUser();
    projectId = await harness.aProject(ownerId);
    token = (await harness.aToken(ownerId)).token;
  });

  afterAll(async () => {
    await harness.close();
  });

  it("fails closed when Mcp-Method disagrees with the body", async () => {
    const response = await post(
      harness.origin,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token, headers: { "mcp-method": "tools/call" } },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe(-32600);
  });

  it("fails closed when Mcp-Name disagrees with the body", async () => {
    const response = await post(harness.origin, call("list_projects", {}), {
      token,
      headers: { "mcp-method": "tools/call", "mcp-name": "delete_resource" },
    });
    expect(response.status).toBe(400);
  });

  it("accepts headers that agree with the body", async () => {
    const response = await post(harness.origin, call("list_projects", {}), {
      token,
      headers: { "mcp-method": "tools/call", "mcp-name": "list_projects" },
    });
    expect(response.status).toBe(200);
  });

  it("refuses a body over the configured limit with 413", async () => {
    const response = await post(
      harness.origin,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_resource",
          arguments: {
            projectId,
            path: "big.seq",
            type: "sequence-diagram",
            content: "x".repeat(2000),
          },
        },
      },
      { token },
    );
    expect(response.status).toBe(413);
  });

  it("refuses a document over its per-type ceiling", async () => {
    const response = await post(
      harness.origin,
      call("upsert_documentation", {
        projectId,
        path: "huge.md",
        content: "y".repeat(5 * 1024 * 1024),
      }),
      { token },
    );
    // Either the transport's body cap or the resource ceiling refuses it; both
    // are refusals rather than a silent truncation.
    expect([413, 200]).toContain(response.status);
    if (response.status === 200) {
      const body = (await response.json()) as any;
      expect(body.result.isError).toBe(true);
    }
  });

  it("meters reads per credential and rejects when the budget is spent", async () => {
    const { token: fresh } = await harness.aToken(ownerId);
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await post(
        harness.origin,
        { jsonrpc: "2.0", id: index, method: "tools/list" },
        { token: fresh },
      );
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get("retry-after")).not.toBeNull();
      }
    }
    expect(statuses.filter((status) => status === 200).length).toBe(3);
    expect(statuses).toContain(429);
  });

  it("does not share one credential's budget with another", async () => {
    const { token: other } = await harness.aToken(ownerId);
    const response = await post(
      harness.origin,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: other },
    );
    expect(response.status).toBe(200);
  });

  it("answers GET with 405 and an Allow header, and no cookie auth", async () => {
    const unauthenticated = await fetch(`${harness.origin}/mcp`, {
      headers: { accept: "text/event-stream" },
    });
    expect(unauthenticated.status).toBe(401);

    const authenticated = await fetch(`${harness.origin}/mcp`, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
      },
    });
    expect(authenticated.status).toBe(405);
    expect(authenticated.headers.get("allow")).toContain("POST");
  });

  it("does not add a permissive CORS header", async () => {
    const response = await post(
      harness.origin,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token },
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("statelessness across instances", () => {
  let harness: McpHarness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("serves a workflow that alternates between two instances", async () => {
    const ownerId = await harness.aUser();
    const projectId = await harness.aProject(ownerId);
    const { token } = await harness.aToken(ownerId);
    const second = await harness.addInstance();

    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    };

    // request 1 → instance A: create
    const create = await fetch(`${harness.url}`, {
      method: "POST",
      headers,
      body: JSON.stringify(
        call("create_resource", {
          projectId,
          path: "alternating.seq",
          type: "sequence-diagram",
          content: "title Alternating\n",
        }),
      ),
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as any;
    const resourceId = created.result.structuredContent.resource.id;

    // request 2 → instance B: read
    const read = await fetch(`${second.url}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "read_resource",
          arguments: { projectId, resource: resourceId },
        },
      }),
    });
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as any;
    expect(readBody.result.structuredContent.content).toBe(
      "title Alternating\n",
    );

    // request 3 → instance A: update using the revision read on B
    const update = await fetch(`${harness.url}`, {
      method: "POST",
      headers,
      body: JSON.stringify(
        call("update_resource", {
          projectId,
          resource: resourceId,
          content: "title Alternating v2\n",
          expectedRevision: 1,
        }),
      ),
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as any;
    expect(updated.result.isError).toBeFalsy();
    expect(updated.result.structuredContent.resource.revision).toBe(2);

    await second.close();
  });

  it("requires no session id and issues none", async () => {
    const ownerId = await harness.aUser();
    const { token } = await harness.aToken(ownerId);
    const response = await post(
      harness.origin,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token },
    );
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  it("reads and updates resource metadata without replacing content", async () => {
    const ownerId = await harness.aUser();
    const projectId = await harness.aProject(ownerId);
    const { token } = await harness.aToken(ownerId);
    const created = await post(
      harness.origin,
      call("create_resource", {
        projectId,
        path: "metadata.seq",
        type: "sequence-diagram",
        content: "title Metadata\n",
      }),
      { token },
    );
    const resourceId = ((await created.json()) as any).result.structuredContent
      .resource.id;
    const updated = await post(
      harness.origin,
      call("update_resource_metadata", {
        projectId,
        resource: resourceId,
        metadata: { description: "  A flow ", tags: ["Core", " core "] },
        expectedRevision: 1,
      }),
      { token },
    );
    const updatedBody = (await updated.json()) as any;
    expect(updatedBody.result.structuredContent.resource.metadata).toEqual({
      description: "A flow",
      tags: ["Core"],
    });
    expect(updatedBody.result.structuredContent.resource.revision).toBe(2);

    const read = await post(
      harness.origin,
      call("read_resource", { projectId, resource: resourceId }),
      { token },
    );
    expect((await read.json()).result.structuredContent.content).toBe(
      "title Metadata\n",
    );
  });
});

describe("concurrency and retries over the wire", () => {
  let harness: McpHarness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("lets one of two racing writers win and refuses the other", async () => {
    const ownerId = await harness.aUser();
    const projectId = await harness.aProject(ownerId);
    const { token } = await harness.aToken(ownerId);

    const created = await post(
      harness.origin,
      call("create_resource", {
        projectId,
        path: "race.seq",
        type: "sequence-diagram",
        content: "title Race\n",
      }),
      { token },
    );
    const resourceId = ((await created.json()) as any).result.structuredContent
      .resource.id;

    const [first, second] = await Promise.all([
      post(
        harness.origin,
        call("update_resource", {
          projectId,
          resource: resourceId,
          content: "title A\n",
          expectedRevision: 1,
        }),
        { token },
      ),
      post(
        harness.origin,
        call("update_resource", {
          projectId,
          resource: resourceId,
          content: "title B\n",
          expectedRevision: 1,
        }),
        { token },
      ),
    ]);

    const results = await Promise.all([first.json(), second.json()]);
    const errors = results.filter((body: any) => body.result?.isError === true);
    const successes = results.filter(
      (body: any) => body.result?.isError !== true,
    );
    expect(successes).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].result.structuredContent.error.code).toBe("conflict");
  });

  it("performs a retried mutation once when the idempotency key repeats", async () => {
    const ownerId = await harness.aUser();
    const projectId = await harness.aProject(ownerId);
    const { token } = await harness.aToken(ownerId);

    const body = call("create_resource", {
      projectId,
      path: "idempotent.seq",
      type: "sequence-diagram",
      content: "title Once\n",
      idempotencyKey: "run-1",
    });
    const first = await post(harness.origin, body, { token });
    const second = await post(harness.origin, body, { token });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const listed = await post(
      harness.origin,
      call("list_resources", { projectId }),
      { token },
    );
    const resources = ((await listed.json()) as any).result.structuredContent
      .resources as any[];
    expect(resources.filter((r) => r.path === "idempotent.seq")).toHaveLength(
      1,
    );
  });

  it("propagates a client-side cancellation to the request", async () => {
    const ownerId = await harness.aUser();
    const { token } = await harness.aToken(ownerId);
    const client = new Client({ name: "cancel-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(harness.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    await expect(
      client.callTool({ name: "list_projects", arguments: {} }, undefined, {
        timeout: 1,
      }),
    ).rejects.toMatchObject({ code: -32001 });
    await client.close();
  });
});
