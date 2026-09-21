/**
 * The project API (ADR-040, ADR-041).
 *
 * What these tests establish is the thing the mission insists on: a request that
 * reaches a project operation is authenticated at the edge, authorized inside the
 * use case, and observable in the audit trail — and the same use case is what
 * MCP will call. The authorization half of the mission's list lives here too,
 * asserted over HTTP rather than only over the catalog.
 */
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../apps/api/config";
import { closeApp, createApp, type AppDependencies } from "../../apps/api/app";
import { createRouter } from "../../apps/api/routes";
import {
  SESSION_COOKIE,
  createSessionToken,
  hashSessionToken,
} from "../../apps/api/context";
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
  volume = await mkdtemp(path.join(tmpdir(), "sd-project-api-"));
  provider = await createTestProvider();
  dependencies = await createApp(
    loadConfig(
      {
        NODE_ENV: "test",
        COOKIE_SECRET: "c".repeat(48),
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

/**
 * A signed-in user, with the cookie that identifies them.
 *
 * Created through the real identity path, so the API's own mapping from
 * `(issuer, subject)` to an internal user is what these tests exercise.
 */
async function signIn(): Promise<{
  cookie: string;
  userId: string;
  token: string;
}> {
  subjectCounter += 1;
  const user = await dependencies.users.findOrCreateByExternalIdentity({
    issuer: provider.issuer,
    subject: `api-subject-${subjectCounter}`,
    displayName: `User ${subjectCounter}`,
    email: null,
  });
  const sessionId = crypto.randomUUID();
  const token = createSessionToken(sessionId);
  await dependencies.sessions.create({
    id: sessionId,
    userId: user.id,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + 600_000),
  });
  return {
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    userId: user.id,
    token,
  };
}

/** Build a request, as the Node adapter would. */
function request(
  method: string,
  url: string,
  options: { cookie?: string; body?: unknown } = {},
): ServerRequest {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const queryIndex = url.indexOf("?");
  return {
    method,
    path: queryIndex === -1 ? url : url.slice(0, queryIndex),
    query: parseQuery(queryIndex === -1 ? "" : url.slice(queryIndex)),
    headers,
    cookies: parseCookies(headers.cookie),
    body: options.body === undefined ? null : JSON.stringify(options.body),
  };
}

/** Call a route and parse its JSON body. */
async function call(
  method: string,
  url: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await router.handle(request(method, url, options));
  return {
    status: response.status,
    body: response.body === "" ? null : JSON.parse(response.body),
  };
}

/** Create a project for a fresh user and return both. */
async function aProject(name = "Payments") {
  const user = await signIn();
  const created = await call("POST", "/api/projects", {
    cookie: user.cookie,
    body: { name },
  });
  return { ...user, projectId: created.body.project.id as string, created };
}

describe("project routes", () => {
  it("refuses every project route without a session", async () => {
    for (const [method, url] of [
      ["GET", "/api/projects"],
      ["POST", "/api/projects"],
      ["GET", "/api/projects/00000000-0000-7000-8000-000000000001"],
      ["DELETE", "/api/projects/00000000-0000-7000-8000-000000000001"],
    ] as const) {
      const response = await call(method, url, { body: { name: "x" } });
      expect(response.status).toBe(401);
    }
  });

  it("creates a project and lists it with the caller's role", async () => {
    const user = await signIn();
    const created = await call("POST", "/api/projects", {
      cookie: user.cookie,
      body: { name: "Payments Platform" },
    });
    expect(created.status).toBe(201);
    expect(created.body.project).toMatchObject({
      name: "Payments Platform",
      slug: "payments-platform",
      role: "OWNER",
      resourceCount: 0,
    });

    const listed = await call("GET", "/api/projects", { cookie: user.cookie });
    expect(listed.body.projects.map((entry: any) => entry.id)).toContain(
      created.body.project.id,
    );
  });

  it("refuses a body with no name", async () => {
    const user = await signIn();
    const created = await call("POST", "/api/projects", {
      cookie: user.cookie,
      body: {},
    });
    expect(created.status).toBe(422);
  });

  it("hides another user's project behind a 404, not a 403", async () => {
    const { projectId } = await aProject("Mine");
    const stranger = await signIn();
    const seen = await call("GET", `/api/projects/${projectId}`, {
      cookie: stranger.cookie,
    });
    expect(seen.status).toBe(404);
    expect(seen.body.error.code).toBe("not_found");
  });

  it("renames and deletes a project for its owner", async () => {
    const { cookie, projectId } = await aProject("Before");
    const patched = await call("PATCH", `/api/projects/${projectId}`, {
      cookie,
      body: { name: "After" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.project.name).toBe("After");

    const removed = await call("DELETE", `/api/projects/${projectId}`, {
      cookie,
    });
    expect(removed.status).toBe(204);
    const gone = await call("GET", `/api/projects/${projectId}`, { cookie });
    expect(gone.status).toBe(404);
  });

  it("adds and removes a member, and lets the member read", async () => {
    const owner = await aProject("Shared");
    const member = await signIn();

    const added = await call(
      "PUT",
      `/api/projects/${owner.projectId}/members/${member.userId}`,
      { cookie: owner.cookie, body: { role: "VIEWER" } },
    );
    expect(added.status).toBe(204);

    const seen = await call("GET", `/api/projects/${owner.projectId}`, {
      cookie: member.cookie,
    });
    expect(seen.status).toBe(200);
    expect(seen.body.project.role).toBe("VIEWER");

    const removed = await call(
      "DELETE",
      `/api/projects/${owner.projectId}/members/${member.userId}`,
      { cookie: owner.cookie },
    );
    expect(removed.status).toBe(204);
    const after = await call("GET", `/api/projects/${owner.projectId}`, {
      cookie: member.cookie,
    });
    expect(after.status).toBe(404);
  });

  it("refuses an unknown role", async () => {
    const owner = await aProject("Roles");
    const member = await signIn();
    const response = await call(
      "PUT",
      `/api/projects/${owner.projectId}/members/${member.userId}`,
      { cookie: owner.cookie, body: { role: "SUPERUSER" } },
    );
    expect(response.status).toBe(422);
  });

  it("stops an editor from administering membership", async () => {
    const owner = await aProject("Editors");
    const editor = await signIn();
    await call(
      "PUT",
      `/api/projects/${owner.projectId}/members/${editor.userId}`,
      {
        cookie: owner.cookie,
        body: { role: "EDITOR" },
      },
    );
    const someone = await signIn();
    const response = await call(
      "PUT",
      `/api/projects/${owner.projectId}/members/${someone.userId}`,
      { cookie: editor.cookie, body: { role: "VIEWER" } },
    );
    expect(response.status).toBe(403);
  });
});

describe("resource routes", () => {
  it("creates, reads, updates, moves and deletes a resource", async () => {
    const { cookie, projectId } = await aProject("Resources");
    const created = await call("POST", `/api/projects/${projectId}/resources`, {
      cookie,
      body: {
        path: "diagrams/checkout.seq",
        type: "sequence-diagram",
        content: "participant A\nA -> B: hi\n",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.resource).toMatchObject({
      path: "diagrams/checkout.seq",
      type: "sequence-diagram",
      revision: 1,
    });
    const resourceId = created.body.resource.id;

    const read = await call(
      "GET",
      `/api/projects/${projectId}/resources/${resourceId}`,
      { cookie },
    );
    expect(read.body.content).toContain("A -> B: hi");
    expect(read.body.resource.revision).toBe(1);

    const updated = await call(
      "PUT",
      `/api/projects/${projectId}/resources/${resourceId}`,
      { cookie, body: { content: "participant A\n", expectedRevision: 1 } },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.resource.revision).toBe(2);

    const moved = await call(
      "POST",
      `/api/projects/${projectId}/resources/${resourceId}/move`,
      { cookie, body: { path: "docs/checkout.seq", expectedRevision: 2 } },
    );
    expect(moved.status).toBe(200);
    expect(moved.body.resource.path).toBe("docs/checkout.seq");

    const removed = await call(
      "DELETE",
      `/api/projects/${projectId}/resources/${resourceId}`,
      { cookie },
    );
    expect(removed.status).toBe(204);
  });

  it("answers 409 for a stale revision and leaves the content alone", async () => {
    const { cookie, projectId } = await aProject("Conflicts");
    const created = await call("POST", `/api/projects/${projectId}/resources`, {
      cookie,
      body: { path: "a.seq", type: "sequence-diagram", content: "first" },
    });
    const resourceId = created.body.resource.id;
    await call("PUT", `/api/projects/${projectId}/resources/${resourceId}`, {
      cookie,
      body: { content: "second", expectedRevision: 1 },
    });

    const stale = await call(
      "PUT",
      `/api/projects/${projectId}/resources/${resourceId}`,
      { cookie, body: { content: "third", expectedRevision: 1 } },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("conflict");
    expect(stale.body.error.details).toEqual({
      expectedRevision: 1,
      currentRevision: 2,
    });

    const read = await call(
      "GET",
      `/api/projects/${projectId}/resources/${resourceId}`,
      { cookie },
    );
    expect(read.body.content).toBe("second");
  });

  it("requires expectedRevision on an update and a move", async () => {
    const { cookie, projectId } = await aProject("Required revision");
    const created = await call("POST", `/api/projects/${projectId}/resources`, {
      cookie,
      body: { path: "a.seq", type: "sequence-diagram", content: "x" },
    });
    const resourceId = created.body.resource.id;
    for (const [method, url] of [
      ["PUT", `/api/projects/${projectId}/resources/${resourceId}`],
      ["POST", `/api/projects/${projectId}/resources/${resourceId}/move`],
    ] as const) {
      const response = await call(method, url, {
        cookie,
        body: { content: "y", path: "b.seq" },
      });
      expect(response.status).toBe(422);
    }
  });

  it("rejects a traversal path as a request error", async () => {
    const { cookie, projectId } = await aProject("Traversal API");
    const response = await call(
      "POST",
      `/api/projects/${projectId}/resources`,
      {
        cookie,
        body: { path: "../../etc/passwd", type: "sequence-diagram" },
      },
    );
    expect(response.status).toBe(422);
  });

  it("refuses a viewer's write with 403 and allows a read", async () => {
    const owner = await aProject("Viewer API");
    const viewer = await signIn();
    await call(
      "PUT",
      `/api/projects/${owner.projectId}/members/${viewer.userId}`,
      {
        cookie: owner.cookie,
        body: { role: "VIEWER" },
      },
    );
    const created = await call(
      "POST",
      `/api/projects/${owner.projectId}/resources`,
      {
        cookie: owner.cookie,
        body: { path: "a.seq", type: "sequence-diagram", content: "x" },
      },
    );

    const read = await call(
      "GET",
      `/api/projects/${owner.projectId}/resources`,
      { cookie: viewer.cookie },
    );
    expect(read.status).toBe(200);

    const write = await call(
      "PUT",
      `/api/projects/${owner.projectId}/resources/${created.body.resource.id}`,
      { cookie: viewer.cookie, body: { content: "y", expectedRevision: 1 } },
    );
    expect(write.status).toBe(403);
  });

  it("lists a resource's revision so a client can thread it", async () => {
    const { cookie, projectId } = await aProject("Listing");
    await call("POST", `/api/projects/${projectId}/resources`, {
      cookie,
      body: { path: "a.seq", type: "sequence-diagram", content: "x" },
    });
    const listed = await call("GET", `/api/projects/${projectId}/resources`, {
      cookie,
    });
    expect(listed.body.resources[0]).toMatchObject({
      path: "a.seq",
      revision: 1,
    });
  });
});

describe("the access endpoint", () => {
  it("reports the caller's role and capabilities", async () => {
    const owner = await aProject("Capabilities");
    const access = await call(
      "GET",
      `/api/projects/${owner.projectId}/access`,
      {
        cookie: owner.cookie,
      },
    );
    expect(access.status).toBe(200);
    expect(access.body.role).toBe("OWNER");
    expect(access.body.permissions).toContain("project:admin");
  });

  it("tells a viewer exactly what it cannot do", async () => {
    const owner = await aProject("Viewer capabilities");
    const viewer = await signIn();
    await call(
      "PUT",
      `/api/projects/${owner.projectId}/members/${viewer.userId}`,
      {
        cookie: owner.cookie,
        body: { role: "VIEWER" },
      },
    );
    const access = await call(
      "GET",
      `/api/projects/${owner.projectId}/access`,
      {
        cookie: viewer.cookie,
      },
    );
    expect(access.body.role).toBe("VIEWER");
    expect(access.body.permissions).toContain("resource:read");
    expect(access.body.permissions).not.toContain("resource:write");
    expect(access.body.permissions).not.toContain("project:admin");
  });

  it("is invisible to a non-member", async () => {
    const owner = await aProject("Private capabilities");
    const stranger = await signIn();
    const access = await call(
      "GET",
      `/api/projects/${owner.projectId}/access`,
      {
        cookie: stranger.cookie,
      },
    );
    expect(access.status).toBe(404);
  });
});

describe("the audit trail over HTTP", () => {
  it("records what a session did, with the correlation id and no secrets", async () => {
    const user = await signIn();
    const created = await call("POST", "/api/projects", {
      cookie: user.cookie,
      body: { name: "Audited API" },
    });
    const projectId = created.body.project.id;
    const resource = await call(
      "POST",
      `/api/projects/${projectId}/resources`,
      {
        cookie: user.cookie,
        body: { path: "a.seq", type: "sequence-diagram", content: "x" },
      },
    );
    await call(
      "PUT",
      `/api/projects/${projectId}/resources/${resource.body.resource.id}`,
      { cookie: user.cookie, body: { content: "y", expectedRevision: 1 } },
    );

    const entries = await dependencies.audit.listForProject(projectId, 50);
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain("project.created");
    expect(actions).toContain("resource.created");
    expect(actions).toContain("resource.updated");
    for (const entry of entries) {
      expect(entry.userId).toBe(user.userId);
      expect(entry.authType).toBe("session");
      expect(entry.requestId).toBeTruthy();
    }
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(user.token);
    expect(serialized).not.toContain("Bearer");
  });
});
