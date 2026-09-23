/**
 * Agent identities and their credentials (ADR-043, Phase 5).
 *
 * The security claims the mission makes about credential management are asserted
 * against the real API and the real database, not a stub: an agent owns several
 * credentials, the plaintext is shown once, the stored row is a keyed digest, a
 * wrong/expired/revoked credential and a disabled agent all fail identically,
 * rotation replaces an old credential, one user can never touch another's, and a
 * credential cannot manage credentials.
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
  AGENT_TOKEN_PREFIX,
  agentPrefixOf,
  createCredentialMint,
  hashAgentToken,
  principalFromCredential,
  resolveAgentCredential,
} from "../../apps/api/auth/agent-credential";
import {
  ADMIN_PERMISSIONS,
  DEFAULT_CREDENTIAL_SCOPES,
} from "../../src/domain/access/permissions";
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
  volume = await mkdtemp(path.join(tmpdir(), "sd-agent-api-"));
  provider = await createTestProvider();
  dependencies = await createApp(
    loadConfig(
      {
        NODE_ENV: "test",
        COOKIE_SECRET: "s".repeat(48),
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

/** A signed-in user with a session cookie. */
async function signIn(): Promise<{ cookie: string; userId: string }> {
  subjectCounter += 1;
  const user = await dependencies.users.findOrCreateByExternalIdentity({
    issuer: provider.issuer,
    subject: `agent-subject-${subjectCounter}`,
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
  };
}

/** Build a request as the Node adapter would. */
function request(
  method: string,
  url: string,
  options: { cookie?: string; authorization?: string; body?: unknown } = {},
): ServerRequest {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.authorization !== undefined)
    headers.authorization = options.authorization;
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
  options: { cookie?: string; authorization?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await router.handle(request(method, url, options));
  return {
    status: response.status,
    body: response.body === "" ? null : JSON.parse(response.body),
  };
}

/** Create an agent through the real route. */
async function createAgent(cookie: string, name = "Hermes Docs") {
  const created = await call("POST", "/api/agents", {
    cookie,
    body: { name, description: "Maintains the docs." },
  });
  expect(created.status).toBe(201);
  return created.body.agent as Record<string, any>;
}

/** Create a credential through the real route. */
async function createCredential(
  cookie: string,
  agentId: string,
  input: Record<string, unknown> = {},
) {
  const created = await call("POST", `/api/agents/${agentId}/credentials`, {
    cookie,
    body: {
      name: "MacMini",
      scopes: [...DEFAULT_CREDENTIAL_SCOPES],
      ...input,
    },
  });
  expect(created.status).toBe(201);
  return {
    secret: created.body.secret as string,
    credential: created.body.credential as Record<string, any>,
  };
}

/** Resolve a token the way the bearer middleware does. */
function resolve(token: string) {
  return resolveAgentCredential(
    dependencies.credentials,
    request("POST", "/mcp", { authorization: `Bearer ${token}` }),
    dependencies.tokenPepper,
  );
}

describe("agent identities", () => {
  it("creates, lists and renames an agent", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    expect(agent).toMatchObject({
      name: "Hermes Docs",
      description: "Maintains the docs.",
      disabled: false,
    });

    const renamed = await call("PATCH", `/api/agents/${agent.id}`, {
      cookie: user.cookie,
      body: { name: "Hermes Documentation" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.agent.name).toBe("Hermes Documentation");

    const listed = await call("GET", "/api/agents", { cookie: user.cookie });
    expect(listed.status).toBe(200);
    expect(listed.body.agents.map((entry: any) => entry.id)).toContain(
      agent.id,
    );
    expect(listed.body.defaultScopes).toEqual([...DEFAULT_CREDENTIAL_SCOPES]);
  });

  it("does not offer an administrative scope to a new credential", async () => {
    const user = await signIn();
    await createAgent(user.cookie);
    const listed = await call("GET", "/api/agents", { cookie: user.cookie });
    for (const permission of ADMIN_PERMISSIONS) {
      expect(listed.body.scopes).not.toContain(permission);
    }
  });

  it("refuses a blank name", async () => {
    const user = await signIn();
    const refused = await call("POST", "/api/agents", {
      cookie: user.cookie,
      body: { name: "   " },
    });
    expect(refused.status).toBe(422);
  });
});

describe("multiple credentials per agent", () => {
  it("supports two independently revocable credentials", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const first = await createCredential(user.cookie, agent.id, {
      name: "Laptop",
    });
    const second = await createCredential(user.cookie, agent.id, {
      name: "CI",
    });

    expect((await resolve(first.secret)).state).toBe("valid");
    expect((await resolve(second.secret)).state).toBe("valid");

    const listed = await call("GET", `/api/agents/${agent.id}/credentials`, {
      cookie: user.cookie,
    });
    expect(listed.body.credentials).toHaveLength(2);

    // Revoking one leaves the other alone.
    await call(
      "DELETE",
      `/api/agents/${agent.id}/credentials/${first.credential.id}`,
      { cookie: user.cookie },
    );
    expect((await resolve(first.secret)).state).toBe("invalid");
    expect((await resolve(second.secret)).state).toBe("valid");
  });
});

describe("the plaintext is shown once and never stored", () => {
  it("returns it only from creation", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const { secret, credential } = await createCredential(
      user.cookie,
      agent.id,
    );

    expect(secret.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(agentPrefixOf(secret)).toBe(credential.prefix);
    expect(Object.keys(credential)).not.toContain("secret");
    expect(Object.keys(credential)).not.toContain("secretHash");
    expect(JSON.stringify(credential)).not.toContain(secret);

    const listed = await call("GET", `/api/agents/${agent.id}/credentials`, {
      cookie: user.cookie,
    });
    expect(JSON.stringify(listed.body)).not.toContain(secret);
  });

  it("stores only a keyed digest", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const { secret, credential } = await createCredential(
      user.cookie,
      agent.id,
    );

    const found = await dependencies.credentials.findById(credential.id);
    expect(found).not.toBeNull();
    expect(found!.credential.secretHash).not.toBe(secret);
    expect(found!.credential.secretHash).toBe(
      hashAgentToken(dependencies.tokenPepper, secret),
    );
    expect(JSON.stringify(found)).not.toContain(secret);
  });

  it("cannot recover it after a reload of the list", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const { secret } = await createCredential(user.cookie, agent.id);
    const again = await call("GET", `/api/agents/${agent.id}/credentials`, {
      cookie: user.cookie,
    });
    expect(again.body.credentials[0]).not.toHaveProperty("secret");
    expect(JSON.stringify(again.body)).not.toContain(secret);
  });
});

describe("authentication", () => {
  it("accepts a valid credential and rejects a wrong secret", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const { secret, credential } = await createCredential(
      user.cookie,
      agent.id,
    );

    expect((await resolve(secret)).state).toBe("valid");

    const wrong = `${AGENT_TOKEN_PREFIX}${credential.prefix}.${"A".repeat(43)}`;
    expect((await resolve(wrong)).state).toBe("invalid");
  });

  it("rejects an unknown credential and a malformed header", async () => {
    for (const header of [
      "Basic dXNlcjpwYXNz",
      "Bearer",
      "Token abc",
      `${AGENT_TOKEN_PREFIX}nothex.${"A".repeat(43)}`,
      `${AGENT_TOKEN_PREFIX}${"0".repeat(16)}.${"A".repeat(43)}`,
    ]) {
      const lookup = await resolveAgentCredential(
        dependencies.credentials,
        request("POST", "/mcp", { authorization: header }),
        dependencies.tokenPepper,
      );
      expect(lookup.state === "valid").toBe(false);
    }
  });

  it("rejects an expired credential", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const minted = createCredentialMint(dependencies.tokenPepper)();
    await dependencies.credentials.create({
      agentId: agent.id,
      name: "Expired",
      publicPrefix: minted.publicPrefix,
      secretHash: minted.secretHash,
      scopes: [...DEFAULT_CREDENTIAL_SCOPES],
      expiresAt: new Date(Date.now() - 1000),
    });
    expect((await resolve(minted.token)).state).toBe("invalid");
  });

  it("rejects every credential of a disabled agent, immediately", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const first = await createCredential(user.cookie, agent.id, {
      name: "One",
    });
    const second = await createCredential(user.cookie, agent.id, {
      name: "Two",
    });

    const disabled = await call("DELETE", `/api/agents/${agent.id}`, {
      cookie: user.cookie,
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.agent.disabled).toBe(true);

    expect((await resolve(first.secret)).state).toBe("invalid");
    expect((await resolve(second.secret)).state).toBe("invalid");

    // Re-enabling restores them: disable is a switch, not a mass revocation.
    await call("POST", `/api/agents/${agent.id}/enable`, {
      cookie: user.cookie,
    });
    expect((await resolve(first.secret)).state).toBe("valid");
  });

  it("records last_used_at on a successful use, and only then", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const { secret, credential } = await createCredential(
      user.cookie,
      agent.id,
    );

    const before = await dependencies.credentials.findById(credential.id);
    expect(before!.credential.lastUsedAt).toBeNull();
    await resolve(secret);
    const after = await dependencies.credentials.findById(credential.id);
    expect(after!.credential.lastUsedAt).not.toBeNull();
  });
});

describe("revocation and rotation", () => {
  it("stops a revoked credential immediately and idempotently", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const { secret, credential } = await createCredential(
      user.cookie,
      agent.id,
    );

    const first = await call(
      "DELETE",
      `/api/agents/${agent.id}/credentials/${credential.id}`,
      { cookie: user.cookie },
    );
    const second = await call(
      "DELETE",
      `/api/agents/${agent.id}/credentials/${credential.id}`,
      { cookie: user.cookie },
    );
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect((await resolve(secret)).state).toBe("invalid");
  });

  it("rotates: the old credential dies and the new one works", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const original = await createCredential(user.cookie, agent.id, {
      name: "Laptop",
      scopes: ["project:read", "resource:read"],
    });
    expect((await resolve(original.secret)).state).toBe("valid");

    const rotated = await call(
      "POST",
      `/api/agents/${agent.id}/credentials/${original.credential.id}/rotate`,
      { cookie: user.cookie },
    );
    expect(rotated.status).toBe(201);
    expect(rotated.body.replacedCredentialId).toBe(original.credential.id);
    expect(rotated.body.credential.scopes).toEqual([
      "project:read",
      "resource:read",
    ]);

    expect((await resolve(original.secret)).state).toBe("invalid");
    expect((await resolve(rotated.body.secret)).state).toBe("valid");

    // A second rotate of the now-revoked credential is refused, so a double
    // call cannot mint a second live secret.
    const again = await call(
      "POST",
      `/api/agents/${agent.id}/credentials/${original.credential.id}/rotate`,
      { cookie: user.cookie },
    );
    expect(again.status).toBe(422);
  });
});

describe("scope and expiry validation", () => {
  it("refuses an unknown scope and a past expiry", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const badScope = await call("POST", `/api/agents/${agent.id}/credentials`, {
      cookie: user.cookie,
      body: { name: "Bad", scopes: ["resource:destroy"] },
    });
    expect(badScope.status).toBe(422);

    const past = await call("POST", `/api/agents/${agent.id}/credentials`, {
      cookie: user.cookie,
      body: {
        name: "Old",
        scopes: ["resource:read"],
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    expect(past.status).toBe(422);
  });

  it("stores a future expiry and reports it", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const expiresAt = new Date(Date.now() + 3_600_000);
    const { credential } = await createCredential(user.cookie, agent.id, {
      expiresAt: expiresAt.toISOString(),
    });
    expect(credential.expiresAt).toBe(expiresAt.toISOString());
    expect(credential.status).toBe("active");
  });
});

describe("one user cannot touch another's agents", () => {
  it("hides them and answers 404 for read, rename, disable and revoke", async () => {
    const owner = await signIn();
    const other = await signIn();
    const agent = await createAgent(owner.cookie);
    const { secret, credential } = await createCredential(
      owner.cookie,
      agent.id,
    );

    const listed = await call("GET", "/api/agents", { cookie: other.cookie });
    expect(JSON.stringify(listed.body)).not.toContain(agent.id);

    const renamed = await call("PATCH", `/api/agents/${agent.id}`, {
      cookie: other.cookie,
      body: { name: "Stolen" },
    });
    expect(renamed.status).toBe(404);

    const disabled = await call("DELETE", `/api/agents/${agent.id}`, {
      cookie: other.cookie,
    });
    expect(disabled.status).toBe(404);

    const creds = await call("GET", `/api/agents/${agent.id}/credentials`, {
      cookie: other.cookie,
    });
    expect(creds.status).toBe(404);

    const revoked = await call(
      "DELETE",
      `/api/agents/${agent.id}/credentials/${credential.id}`,
      { cookie: other.cookie },
    );
    expect(revoked.status).toBe(404);

    // Nothing above had an effect.
    expect((await resolve(secret)).state).toBe("valid");
  });

  it("refuses a credential-management call from a credential itself", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const { secret } = await createCredential(user.cookie, agent.id, {
      scopes: ["project:read", "agent:manage", "credential:manage"],
    });
    // Even a credential explicitly granted management scopes cannot manage:
    // the management surface is session-only.
    const listed = await call("GET", "/api/agents", {
      authorization: `Bearer ${secret}`,
    });
    expect(listed.status).toBe(401);
  });
});

describe("project restrictions", () => {
  it("stores a restriction only for a project the owner can see", async () => {
    const owner = await signIn();
    const other = await signIn();
    const project = await call("POST", "/api/projects", {
      cookie: owner.cookie,
      body: { name: "Restricted project", workspaceId: owner.userId },
    });
    const agent = await createAgent(owner.cookie);

    const allowed = await createCredential(owner.cookie, agent.id, {
      allowedProjectIds: [project.body.project.id],
    });
    expect(allowed.credential.allowedProjectIds).toEqual([
      project.body.project.id,
    ]);

    const refused = await call("POST", `/api/agents/${agent.id}/credentials`, {
      cookie: other.cookie,
      body: {
        name: "Snoop",
        scopes: ["resource:read"],
        allowedProjectIds: [project.body.project.id],
      },
    });
    expect(refused.status).toBe(404);
  });
});

describe("audit attribution", () => {
  it("records the subject and the actor for agent lifecycle events", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const { secret, credential } = await createCredential(
      user.cookie,
      agent.id,
    );
    await call("DELETE", `/api/agents/${agent.id}`, { cookie: user.cookie });

    const events = await dependencies.audit.listForUser(user.userId, 50);
    const actions = events.map((event) => event.action);
    expect(actions).toContain("agent.created");
    expect(actions).toContain("credential.created");
    expect(actions).toContain("agent.disabled");
    // The session that managed the agent is the actor and the subject.
    for (const event of events) {
      expect(event.subjectUserId).toBe(user.userId);
      expect(event.actorType).toBe("user");
    }
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(credential.prefix);
  });
});

describe("the shared API converges on one principal", () => {
  it("serves the project routes to a bearer credential", async () => {
    const user = await signIn();
    await call("POST", "/api/projects", {
      cookie: user.cookie,
      body: { name: "Bearer visible", workspaceId: user.userId },
    });
    const agent = await createAgent(user.cookie);
    const { secret } = await createCredential(user.cookie, agent.id, {
      scopes: ["project:read"],
    });

    const listed = await call(
      "GET",
      `/api/projects?workspaceId=${user.userId}`,
      {
        authorization: `Bearer ${secret}`,
      },
    );
    expect(listed.status).toBe(200);
    expect(listed.body.projects.map((entry: any) => entry.name)).toContain(
      "Bearer visible",
    );
  });

  it("returns who a bearer credential is, without a session", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const { secret, credential } = await createCredential(
      user.cookie,
      agent.id,
      {
        scopes: ["project:read"],
      },
    );
    const me = await call("GET", "/api/me", {
      authorization: `Bearer ${secret}`,
    });
    expect(me.status).toBe(200);
    expect(me.body.user).toBeNull();
    expect(me.body.principal.subjectUserId).toBe(user.userId);
    expect(me.body.principal.actor).toEqual({
      kind: "agent",
      agentId: agent.id,
      credentialId: credential.id,
    });
  });

  it("lets the Authorization header win over a session cookie", async () => {
    const sessionUser = await signIn();
    const otherUser = await signIn();
    await call("POST", "/api/projects", {
      cookie: sessionUser.cookie,
      body: { name: "Session project", workspaceId: sessionUser.userId },
    });
    await call("POST", "/api/projects", {
      cookie: otherUser.cookie,
      body: { name: "Bearer project", workspaceId: otherUser.userId },
    });
    const agent = await createAgent(otherUser.cookie);
    const { secret } = await createCredential(otherUser.cookie, agent.id, {
      scopes: ["project:read"],
    });

    const listed = await call(
      "GET",
      `/api/projects?workspaceId=${otherUser.userId}`,
      {
        cookie: sessionUser.cookie,
        authorization: `Bearer ${secret}`,
      },
    );
    const names = listed.body.projects.map((entry: any) => entry.name);
    expect(names).toContain("Bearer project");
    expect(names).not.toContain("Session project");
  });

  it("refuses a bad bearer even when the session cookie is valid", async () => {
    const user = await signIn();
    const refused = await call("GET", "/api/projects", {
      cookie: user.cookie,
      authorization: "Bearer sdm_pat_0000000000000000." + "A".repeat(43),
    });
    expect(refused.status).toBe(401);
  });
});

describe("principal construction", () => {
  it("carries the owner as subject and the agent as actor", async () => {
    const user = await signIn();
    const agent = await createAgent(user.cookie);
    const { secret, credential } = await createCredential(
      user.cookie,
      agent.id,
      {
        scopes: ["project:read", "resource:read", "resource:update"],
      },
    );
    const lookup = await resolve(secret);
    expect(lookup.state).toBe("valid");
    if (lookup.state !== "valid") return;
    const principal = principalFromCredential(lookup.credential, lookup.agent);
    expect(principal.subjectUserId).toBe(user.userId);
    expect(principal.actor).toEqual({
      kind: "agent",
      agentId: agent.id,
      credentialId: credential.id,
    });
    expect(principal.authType).toBe("pat");
    expect(principal.displayName).toBe("Hermes Docs");
    expect(principal.scopes).toContain("resource:update");
  });
});
