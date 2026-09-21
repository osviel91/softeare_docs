/**
 * The remote MCP endpoint (Phase 5, checkpoints 5C and 5D).
 *
 * The whole agent surface is driven the way a real client drives it: a bearer
 * PAT over HTTP, a JSON-RPC message in, a JSON-RPC result out. Nothing is called
 * directly, so what these tests prove is exactly what a remote agent gets —
 * authentication, the tool listing a scope produces, isolation, and the
 * revision-conflict contract on a write.
 */
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../apps/api/config";
import { closeApp, createApp, type AppDependencies } from "../../apps/api/app";
import { createRouter } from "../../apps/api/routes";
import { contextFor, SESSION_SCOPES } from "../../apps/api/context";
import { generatePat } from "../../apps/api/auth/pat";
import {
  LATEST_PROTOCOL_VERSION,
  ErrorCode,
} from "../../src/shared/mcp/protocol";
import {
  parseCookies,
  parseQuery,
  type ServerRequest,
} from "../../apps/api/http/http";
import { createTestProvider, type TestProvider } from "./test-provider";

let dependencies: AppDependencies;
let volume: string;
let provider: TestProvider;
let router: ReturnType<typeof createRouter>;

beforeAll(async () => {
  volume = await mkdtemp(path.join(tmpdir(), "sd-mcp-remote-"));
  provider = await createTestProvider();
  dependencies = await createApp(
    loadConfig(
      {
        NODE_ENV: "test",
        COOKIE_SECRET: "m".repeat(48),
        PUBLIC_URL: "http://localhost:4000",
        PROJECT_VOLUME: volume,
        PGLITE_DIR: "memory://",
        OIDC_ISSUER: provider.issuer,
        OIDC_CLIENT_ID: provider.clientId,
        OIDC_CLIENT_SECRET: provider.clientSecret,
        OIDC_REDIRECT_URI: provider.redirectUri,
      },
      { oidcFetch: provider.fetch },
    ),
  );
  router = createRouter(dependencies);
});

afterAll(async () => {
  await closeApp(dependencies);
  await rm(volume, { recursive: true, force: true });
});

let subjectCounter = 0;

/** An internal user with no browser session. */
async function aUser(): Promise<string> {
  subjectCounter += 1;
  const user = await dependencies.users.findOrCreateByExternalIdentity({
    issuer: provider.issuer,
    subject: `mcp-remote-${subjectCounter}`,
    displayName: `User ${subjectCounter}`,
    email: null,
  });
  return user.id;
}

/** Issue a PAT for a user and return its plaintext. */
async function issueToken(
  userId: string,
  scopes: readonly string[],
  projectIds?: readonly string[],
): Promise<string> {
  const minted = generatePat();
  await dependencies.tokens.create({
    userId,
    name: "Agent",
    prefix: minted.prefix,
    tokenHash: minted.tokenHash,
    scopes,
    ...(projectIds === undefined ? {} : { projectIds }),
  });
  return minted.token;
}

/** Create a project for a user through the catalog (a session context). */
async function aProject(ownerId: string, name: string): Promise<string> {
  const context = contextFor(
    { userId: ownerId, authType: "session", scopes: SESSION_SCOPES },
    "req-owner",
  );
  const listing = await dependencies.catalog.createProject(context, { name });
  return listing.project.id;
}

/** Build a request as the Node adapter would. */
function request(
  method: string,
  url: string,
  options: { authorization?: string; body?: unknown; raw?: string } = {},
): ServerRequest {
  const headers: Record<string, string> = {};
  if (options.authorization !== undefined)
    headers.authorization = options.authorization;
  if (options.body !== undefined || options.raw !== undefined)
    headers["content-type"] = "application/json";
  const queryIndex = url.indexOf("?");
  return {
    method,
    path: queryIndex === -1 ? url : url.slice(0, queryIndex),
    query: parseQuery(queryIndex === -1 ? "" : url.slice(queryIndex)),
    headers,
    cookies: parseCookies(headers.cookie),
    body:
      options.raw !== undefined
        ? options.raw
        : options.body === undefined
          ? null
          : JSON.stringify(options.body),
  };
}

/** POST one JSON-RPC message and parse the response. */
async function mcp(
  token: string | undefined,
  body: unknown,
  options: { raw?: string } = {},
): Promise<{ status: number; body: any }> {
  const response = await router.handle(
    request("POST", "/mcp", {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(options.raw === undefined ? { body } : { raw: options.raw }),
    }),
  );
  return {
    status: response.status,
    body: response.body === "" ? null : JSON.parse(response.body),
  };
}

/** Call a tool and assert the result was a success, returning its content. */
async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ structured: any; text: string }> {
  const response = await mcp(token, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(response.status).toBe(200);
  const result = response.body.result;
  expect(result.isError).toBe(false);
  return {
    structured: result.structuredContent,
    text: result.content[0].text as string,
  };
}

/** Call a tool and return its structured error. */
async function failedTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ code: string; details?: Record<string, unknown>; text: string }> {
  const response = await mcp(token, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(response.status).toBe(200);
  const result = response.body.result;
  expect(result.isError).toBe(true);
  return {
    code: result.structuredContent.error.code,
    details: result.structuredContent.error.details,
    text: result.content[0].text as string,
  };
}

describe("transport and authentication", () => {
  it("refuses a request with no token", async () => {
    const response = await mcp(undefined, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unauthorized");
  });

  it("refuses an invalid token", async () => {
    const response = await mcp("sdm_pat_0000000000000000." + "A".repeat(43), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(401);
  });

  it("refuses a revoked token immediately", async () => {
    const userId = await aUser();
    const token = await issueToken(userId, ["projects:read"]);
    const record = (await dependencies.tokens.listForUser(userId))[0];
    await dependencies.tokens.revoke(userId, record.id);

    const response = await mcp(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(401);
  });

  it("answers a malformed body with a 400 parse error", async () => {
    const token = await issueToken(await aUser(), ["projects:read"]);
    const response = await mcp(token, {}, { raw: "{not json" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.ParseError);
  });

  it("answers GET with 405 and DELETE with 204", async () => {
    const token = await issueToken(await aUser(), ["projects:read"]);
    const get = await router.handle(
      request("GET", "/mcp", { authorization: `Bearer ${token}` }),
    );
    expect(get.status).toBe(405);
    const del = await router.handle(
      request("DELETE", "/mcp", { authorization: `Bearer ${token}` }),
    );
    expect(del.status).toBe(204);
  });
});

describe("protocol handshake", () => {
  it("answers initialize and server/discover", async () => {
    const token = await issueToken(await aUser(), ["projects:read"]);
    const initialized = await mcp(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION },
    });
    expect(initialized.body.result.protocolVersion).toBe(
      LATEST_PROTOCOL_VERSION,
    );
    expect(initialized.body.result.capabilities.tools).toBeDefined();
    expect(initialized.body.result.serverInfo.name).toBe(
      "sequencediagrams-remote",
    );

    const discovered = await mcp(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "server/discover",
    });
    expect(discovered.body.result.supportedVersions).toContain(
      LATEST_PROTOCOL_VERSION,
    );
  });

  it("acknowledges a notification with 202 and no body", async () => {
    const token = await issueToken(await aUser(), ["projects:read"]);
    const response = await mcp(token, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
  });

  it("refuses an unsupported protocol version header", async () => {
    const token = await issueToken(await aUser(), ["projects:read"]);
    const response = await router.handle({
      ...request("POST", "/mcp", {
        authorization: `Bearer ${token}`,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "1900-01-01",
      },
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe(
      ErrorCode.UnsupportedProtocolVersion,
    );
  });

  it("reports an unknown method as a protocol error", async () => {
    const token = await issueToken(await aUser(), ["projects:read"]);
    const response = await mcp(token, {
      jsonrpc: "2.0",
      id: 3,
      method: "does/not/exist",
    });
    expect(response.body.error.code).toBe(ErrorCode.MethodNotFound);
  });
});

describe("tool listing follows the scope", () => {
  it("offers only read tools to a read-only token", async () => {
    const token = await issueToken(await aUser(), ["projects:read"]);
    const response = await mcp(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = response.body.result.tools.map((tool: any) => tool.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("read_resource");
    expect(names).not.toContain("create_resource");
    expect(names).not.toContain("update_resource");
    expect(names).not.toContain("move_resource");
    expect(names).not.toContain("delete_resource");
  });

  it("offers the write tools to a writer token", async () => {
    const token = await issueToken(await aUser(), ["projects:write"]);
    const response = await mcp(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = response.body.result.tools.map((tool: any) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "create_resource",
        "update_resource",
        "move_resource",
        "delete_resource",
      ]),
    );
  });

  it("refuses an unknown tool name", async () => {
    const token = await issueToken(await aUser(), ["projects:write"]);
    const response = await mcp(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "drop_everything", arguments: {} },
    });
    expect(response.body.error.code).toBe(ErrorCode.InvalidParams);
  });
});

describe("reading through the remote MCP", () => {
  it("lists projects and reads a resource", async () => {
    const owner = await aUser();
    const projectId = await aProject(owner, "Remote project");
    const writer = await issueToken(owner, ["projects:write"]);
    const reader = await issueToken(owner, ["projects:read"]);

    const created = await callTool(writer, "create_resource", {
      projectId,
      path: "checkout.seq",
      type: "sequence-diagram",
      content: "participant Browser\nBrowser ->> Gateway: Submit\n",
    });
    expect(created.structured.resource.revision).toBe(1);

    const projects = await callTool(reader, "list_projects", {});
    expect(
      projects.structured.projects.map((entry: any) => entry.id),
    ).toContain(projectId);

    const resources = await callTool(reader, "list_resources", { projectId });
    expect(resources.structured.resources[0].path).toBe("checkout.seq");

    const read = await callTool(reader, "read_resource", {
      projectId,
      resource: "checkout.seq",
    });
    expect(read.structured.content).toContain("Submit");
    expect(read.structured.resource.revision).toBe(1);

    const project = await callTool(reader, "get_project", { projectId });
    expect(project.structured.access.permissions).not.toContain(
      "resource:write",
    );
  });

  it("hides another user's project rather than forbidding it", async () => {
    const owner = await aUser();
    const stranger = await aUser();
    const projectId = await aProject(owner, "Owner only");
    const token = await issueToken(stranger, ["projects:write"]);

    const failure = await failedTool(token, "list_resources", { projectId });
    expect(failure.code).toBe("not_found");

    const listed = await callTool(token, "list_projects", {});
    expect(listed.structured.projects).toEqual([]);
  });
});

describe("writing through the remote MCP", () => {
  it("creates, updates, moves and deletes a resource", async () => {
    const owner = await aUser();
    const projectId = await aProject(owner, "Write project");
    const token = await issueToken(owner, ["projects:write"]);

    const created = await callTool(token, "create_resource", {
      projectId,
      path: "notes/overview.md",
      type: "markdown-document",
      content: "# Overview",
    });
    const id = created.structured.resource.id as string;

    const updated = await callTool(token, "update_resource", {
      projectId,
      resource: id,
      content: "# Overview\n\nMore.",
      expectedRevision: 1,
    });
    expect(updated.structured.resource.revision).toBe(2);

    const moved = await callTool(token, "move_resource", {
      projectId,
      resource: id,
      path: "notes/intro.md",
      expectedRevision: 2,
    });
    expect(moved.structured.resource.path).toBe("notes/intro.md");

    await callTool(token, "delete_resource", {
      projectId,
      resource: id,
      confirm: true,
    });
    const resources = await callTool(token, "list_resources", { projectId });
    expect(resources.structured.resources).toEqual([]);
  });

  it("preserves optimistic concurrency: a stale write is a conflict", async () => {
    const owner = await aUser();
    const projectId = await aProject(owner, "Concurrency");
    const token = await issueToken(owner, ["projects:write"]);

    const created = await callTool(token, "create_resource", {
      projectId,
      path: "doc.md",
      type: "markdown-document",
      content: "# One",
    });
    const id = created.structured.resource.id as string;

    // A second client (the browser, say) writes first.
    const session = contextFor(
      { userId: owner, authType: "session", scopes: SESSION_SCOPES },
      "req-browser",
    );
    await dependencies.catalog.updateResource(session, projectId, id, {
      content: "# Two",
      expectedRevision: 1,
    });

    // The agent still holds revision 1 and must be refused.
    const stale = await failedTool(token, "update_resource", {
      projectId,
      resource: id,
      content: "# Agent",
      expectedRevision: 1,
    });
    expect(stale.code).toBe("conflict");
    expect(stale.details).toMatchObject({
      expectedRevision: 1,
      currentRevision: 2,
    });
    expect(stale.text).toContain("revision");

    // The browser's content survived.
    const current = await callTool(token, "read_resource", {
      projectId,
      resource: id,
    });
    expect(current.structured.content).toBe("# Two");

    // Retrying at the current revision succeeds.
    const retried = await callTool(token, "update_resource", {
      projectId,
      resource: id,
      content: "# Agent",
      expectedRevision: 2,
    });
    expect(retried.structured.resource.revision).toBe(3);
  });

  it("requires an expected revision on a write", async () => {
    const owner = await aUser();
    const projectId = await aProject(owner, "Required revision");
    const token = await issueToken(owner, ["projects:write"]);
    const created = await callTool(token, "create_resource", {
      projectId,
      path: "doc.md",
      type: "markdown-document",
      content: "# One",
    });

    const failure = await failedTool(token, "update_resource", {
      projectId,
      resource: created.structured.resource.id,
      content: "# Blind",
    });
    expect(failure.code).toBe("validation");
    expect(failure.text).toContain("expectedRevision");
  });

  it("refuses a write from a read-only token even where it is a member", async () => {
    const owner = await aUser();
    const projectId = await aProject(owner, "Read only");
    const writer = await issueToken(owner, ["projects:write"]);
    const reader = await issueToken(owner, ["projects:read"]);
    const created = await callTool(writer, "create_resource", {
      projectId,
      path: "doc.md",
      type: "markdown-document",
      content: "# One",
    });

    const failure = await failedTool(reader, "update_resource", {
      projectId,
      resource: created.structured.resource.id,
      content: "# Nope",
      expectedRevision: 1,
    });
    expect(failure.code).toBe("forbidden");
    expect(failure.text).toContain("mcp:write");
  });

  it("refuses a path traversal as an invalid path", async () => {
    const owner = await aUser();
    const projectId = await aProject(owner, "Traversal");
    const token = await issueToken(owner, ["projects:write"]);
    const failure = await failedTool(token, "create_resource", {
      projectId,
      path: "../../escape.seq",
      type: "sequence-diagram",
      content: "",
    });
    expect(failure.code).toBe("invalid_path");
  });

  it("requires confirmation to delete", async () => {
    const owner = await aUser();
    const projectId = await aProject(owner, "Confirm");
    const token = await issueToken(owner, ["projects:write"]);
    const created = await callTool(token, "create_resource", {
      projectId,
      path: "doc.md",
      type: "markdown-document",
      content: "# One",
    });
    const failure = await failedTool(token, "delete_resource", {
      projectId,
      resource: created.structured.resource.id,
      confirm: false,
    });
    expect(failure.code).toBe("validation");
  });

  it("does not resolve a resource id from another project", async () => {
    const owner = await aUser();
    const first = await aProject(owner, "First");
    const second = await aProject(owner, "Second");
    const token = await issueToken(owner, ["projects:write"]);
    const created = await callTool(token, "create_resource", {
      projectId: first,
      path: "doc.md",
      type: "markdown-document",
      content: "# One",
    });

    const failure = await failedTool(token, "update_resource", {
      projectId: second,
      resource: created.structured.resource.id,
      content: "# Stolen",
      expectedRevision: 1,
    });
    expect(failure.code).toBe("not_found");
  });

  it("keeps a project-restricted token inside its project", async () => {
    const owner = await aUser();
    const allowed = await aProject(owner, "Allowed");
    const other = await aProject(owner, "Other");
    const token = await issueToken(owner, ["projects:write"], [allowed]);

    const listed = await callTool(token, "list_projects", {});
    expect(listed.structured.projects.map((entry: any) => entry.id)).toEqual([
      allowed,
    ]);

    const failure = await failedTool(token, "list_resources", {
      projectId: other,
    });
    expect(failure.code).toBe("not_found");
  });
});

describe("reconnect", () => {
  it("serves a second request with the same credential, statelessly", async () => {
    const owner = await aUser();
    await aProject(owner, "Reconnect");
    const token = await issueToken(owner, ["projects:read"]);

    const first = await mcp(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const second = await mcp(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.result.tools).toEqual(first.body.result.tools);
  });
});
