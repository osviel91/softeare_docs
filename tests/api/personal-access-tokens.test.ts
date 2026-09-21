/**
 * Personal Access Tokens: lifecycle, storage and verification (Phase 5).
 *
 * The security claims the mission makes about PATs are all asserted against the
 * real API and the real database, not a stub: the plaintext is shown once, the
 * stored row is a digest, a wrong secret fails, revocation is immediate, a token
 * belongs to one user, and a machine token cannot manage tokens.
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
  PAT_PREFIX,
  generatePat,
  hashPatToken,
  patPrefixOf,
  principalFromPat,
  resolvePat,
} from "../../apps/api/auth/pat";
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
  volume = await mkdtemp(path.join(tmpdir(), "sd-pat-api-"));
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
    subject: `pat-subject-${subjectCounter}`,
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
  options: {
    cookie?: string;
    authorization?: string;
    body?: unknown;
  } = {},
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
  options: {
    cookie?: string;
    authorization?: string;
    body?: unknown;
  } = {},
): Promise<{ status: number; body: any }> {
  const response = await router.handle(request(method, url, options));
  return {
    status: response.status,
    body: response.body === "" ? null : JSON.parse(response.body),
  };
}

/** Create a token through the real route and return its plaintext and record. */
async function createToken(
  cookie: string,
  input: Record<string, unknown> = { scopes: ["projects:read"] },
) {
  const created = await call("POST", "/api/tokens", {
    cookie,
    body: { name: "Agent", ...input },
  });
  expect(created.status).toBe(201);
  return {
    secret: created.body.secret as string,
    token: created.body.token as Record<string, any>,
  };
}

describe("token creation", () => {
  it("returns the plaintext exactly once, in the creation response", async () => {
    const user = await signIn();
    const { secret, token } = await createToken(user.cookie, {
      name: "Docs agent",
      scopes: ["projects:write"],
    });

    expect(secret.startsWith(PAT_PREFIX)).toBe(true);
    expect(patPrefixOf(secret)).toBe(token.prefix);
    expect(token).toMatchObject({
      name: "Docs agent",
      scopes: ["projects:write"],
      revoked: false,
      expiresAt: null,
      lastUsedAt: null,
    });
    // The metadata view has no field a secret or a digest could occupy.
    expect(Object.keys(token)).not.toContain("secret");
    expect(Object.keys(token)).not.toContain("tokenHash");
    expect(JSON.stringify(token)).not.toContain(secret);
  });

  it("never stores the plaintext", async () => {
    const user = await signIn();
    const { secret, token } = await createToken(user.cookie);

    const stored = await dependencies.tokens.findByPrefix(token.prefix);
    expect(stored).not.toBeNull();
    expect(stored!.tokenHash).not.toBe(secret);
    expect(stored!.tokenHash).toBe(hashPatToken(secret));
    // A database dump contains no substring of the credential.
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  it("is not returned again by list or read", async () => {
    const user = await signIn();
    const { secret, token } = await createToken(user.cookie);

    const listed = await call("GET", "/api/tokens", { cookie: user.cookie });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    expect(listed.body.tokens.map((entry: any) => entry.id)).toContain(
      token.id,
    );
    expect(listed.body.scopes).toEqual(["projects:read", "projects:write"]);

    const read = await call("GET", `/api/tokens/${token.id}`, {
      cookie: user.cookie,
    });
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(secret);
  });

  it("refuses an unknown or empty scope", async () => {
    const user = await signIn();
    const unknown = await call("POST", "/api/tokens", {
      cookie: user.cookie,
      body: { name: "Bad", scopes: ["resource:admin"] },
    });
    expect(unknown.status).toBe(422);

    const empty = await call("POST", "/api/tokens", {
      cookie: user.cookie,
      body: { name: "Bad", scopes: [] },
    });
    expect(empty.status).toBe(422);
  });

  it("refuses a past or malformed expiry", async () => {
    const user = await signIn();
    const past = await call("POST", "/api/tokens", {
      cookie: user.cookie,
      body: {
        name: "Old",
        scopes: ["projects:read"],
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    expect(past.status).toBe(422);

    const malformed = await call("POST", "/api/tokens", {
      cookie: user.cookie,
      body: { name: "Bad", scopes: ["projects:read"], expiresAt: 1700000000 },
    });
    expect(malformed.status).toBe(422);
  });

  it("records a future expiry and returns it", async () => {
    const user = await signIn();
    const expiresAt = new Date(Date.now() + 3_600_000);
    const created = await createToken(user.cookie, {
      name: "Temporary",
      scopes: ["projects:read"],
      expiresAt: expiresAt.toISOString(),
    });
    expect(created.token.expiresAt).toBe(expiresAt.toISOString());
  });
});

describe("authentication", () => {
  it("requires a session cookie for management", async () => {
    const anonymous = await call("GET", "/api/tokens");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe("unauthorized");
  });

  it("does not accept a PAT as a credential for token management", async () => {
    const user = await signIn();
    const { secret } = await createToken(user.cookie);
    const asBearer = await call("GET", "/api/tokens", {
      authorization: `Bearer ${secret}`,
    });
    // A machine credential is not a browser session; the cookie is what counts.
    expect(asBearer.status).toBe(401);
  });

  it("accepts a valid PAT and rejects a wrong secret", async () => {
    const user = await signIn();
    const { secret } = await createToken(user.cookie);
    const prefix = patPrefixOf(secret)!;

    const valid = await resolvePat(
      dependencies.tokens,
      request("POST", "/mcp", { authorization: `Bearer ${secret}` }),
    );
    expect(valid.state).toBe("valid");

    const wrongSecret = `${PAT_PREFIX}${prefix}.${"A".repeat(43)}`;
    const invalid = await resolvePat(
      dependencies.tokens,
      request("POST", "/mcp", { authorization: `Bearer ${wrongSecret}` }),
    );
    expect(invalid.state).toBe("invalid");
  });

  it("rejects a malformed or unsupported Authorization header", async () => {
    const cases = [
      "Basic dXNlcjpwYXNz",
      "Bearer",
      "Bearer ",
      "Token abc",
      "sdm_pat_nope",
      `${PAT_PREFIX}notahexprefix.${"A".repeat(43)}`,
    ];
    for (const header of cases) {
      const lookup = await resolvePat(
        dependencies.tokens,
        request("POST", "/mcp", { authorization: header }),
      );
      expect(lookup.state).toBe("invalid");
    }

    const none = await resolvePat(dependencies.tokens, request("POST", "/mcp"));
    expect(none.state).toBe("none");
  });

  it("records last_used_at on a successful use, and only then", async () => {
    const user = await signIn();
    const { secret, token } = await createToken(user.cookie);
    const before = await dependencies.tokens.findById(token.id);
    expect(before!.lastUsedAt).toBeNull();

    await resolvePat(
      dependencies.tokens,
      request("POST", "/mcp", { authorization: `Bearer ${secret}` }),
    );

    const after = await dependencies.tokens.findById(token.id);
    expect(after!.lastUsedAt).not.toBeNull();
  });
});

describe("revocation and expiry", () => {
  it("stops a revoked token immediately", async () => {
    const user = await signIn();
    const { secret, token } = await createToken(user.cookie);

    const revoked = await call("DELETE", `/api/tokens/${token.id}`, {
      cookie: user.cookie,
    });
    expect(revoked.status).toBe(204);

    const lookup = await resolvePat(
      dependencies.tokens,
      request("POST", "/mcp", { authorization: `Bearer ${secret}` }),
    );
    expect(lookup.state).toBe("invalid");

    const listed = await call("GET", "/api/tokens", { cookie: user.cookie });
    expect(listed.body.tokens[0].revoked).toBe(true);
  });

  it("stops an expired token", async () => {
    const user = await signIn();
    const minted = generatePat();
    const record = await dependencies.tokens.create({
      userId: user.userId,
      name: "Expired",
      prefix: minted.prefix,
      tokenHash: minted.tokenHash,
      scopes: ["projects:read"],
      expiresAt: new Date(Date.now() - 1000),
    });

    const lookup = await resolvePat(
      dependencies.tokens,
      request("POST", "/mcp", {
        authorization: `Bearer ${minted.token}`,
      }),
    );
    expect(lookup.state).toBe("invalid");
    expect(record.expiresAt).not.toBeNull();
  });

  it("is idempotent: revoking twice is not an error", async () => {
    const user = await signIn();
    const { token } = await createToken(user.cookie);
    const first = await call("DELETE", `/api/tokens/${token.id}`, {
      cookie: user.cookie,
    });
    const second = await call("DELETE", `/api/tokens/${token.id}`, {
      cookie: user.cookie,
    });
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });
});

describe("one user cannot touch another's token", () => {
  it("hides it from the list and answers 404 for read, rename and revoke", async () => {
    const owner = await signIn();
    const other = await signIn();
    const { secret, token } = await createToken(owner.cookie);

    const listed = await call("GET", "/api/tokens", { cookie: other.cookie });
    expect(JSON.stringify(listed.body)).not.toContain(token.id);

    const read = await call("GET", `/api/tokens/${token.id}`, {
      cookie: other.cookie,
    });
    expect(read.status).toBe(404);

    const renamed = await call("PATCH", `/api/tokens/${token.id}`, {
      cookie: other.cookie,
      body: { name: "Stolen" },
    });
    expect(renamed.status).toBe(404);

    const revoked = await call("DELETE", `/api/tokens/${token.id}`, {
      cookie: other.cookie,
    });
    expect(revoked.status).toBe(404);

    // The owner's token still authenticates: nothing above had an effect.
    const lookup = await resolvePat(
      dependencies.tokens,
      request("POST", "/mcp", { authorization: `Bearer ${secret}` }),
    );
    expect(lookup.state).toBe("valid");
  });
});

describe("rename and audit", () => {
  it("renames only the caller's own token", async () => {
    const user = await signIn();
    const { token } = await createToken(user.cookie);
    const renamed = await call("PATCH", `/api/tokens/${token.id}`, {
      cookie: user.cookie,
      body: { name: "Renamed agent" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.token.name).toBe("Renamed agent");
  });

  it("audits creation and revocation without recording the secret", async () => {
    const user = await signIn();
    const { secret, token } = await createToken(user.cookie, {
      name: "Audited",
      scopes: ["projects:read"],
    });
    await call("DELETE", `/api/tokens/${token.id}`, { cookie: user.cookie });

    const events = await dependencies.audit.listForUser(user.userId, 50);
    const actions = events.map((event) => event.action);
    expect(actions).toContain("token.created");
    expect(actions).toContain("token.revoked");
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});

describe("principal construction", () => {
  it("carries the owner's identity, the credential id and the scopes", async () => {
    const user = await signIn();
    const { token } = await createToken(user.cookie, {
      name: "Reader",
      scopes: ["projects:read"],
    });
    const record = await dependencies.tokens.findById(token.id);
    const principal = principalFromPat(record!);
    expect(principal.userId).toBe(user.userId);
    expect(principal.authType).toBe("pat");
    expect(principal.credentialId).toBe(token.id);
    expect(principal.displayName).toBe("Reader");
    expect(principal.scopes).toContain("resource:read");
    expect(principal.scopes).not.toContain("resource:write");
  });

  it("restricts the principal to the projects the token names", async () => {
    const user = await signIn();
    const project = await call("POST", "/api/projects", {
      cookie: user.cookie,
      body: { name: "Scoped" },
    });
    const { token } = await createToken(user.cookie, {
      name: "Scoped agent",
      scopes: ["projects:read"],
      projectIds: [project.body.project.id],
    });
    const record = await dependencies.tokens.findById(token.id);
    const principal = principalFromPat(record!);
    expect(principal.projectIds).toEqual([project.body.project.id]);
  });

  it("refuses a project restriction naming a project the user cannot see", async () => {
    const owner = await signIn();
    const other = await signIn();
    const project = await call("POST", "/api/projects", {
      cookie: owner.cookie,
      body: { name: "Private" },
    });
    const response = await call("POST", "/api/tokens", {
      cookie: other.cookie,
      body: {
        name: "Snoop",
        scopes: ["projects:read"],
        projectIds: [project.body.project.id],
      },
    });
    expect(response.status).toBe(404);
  });
});
