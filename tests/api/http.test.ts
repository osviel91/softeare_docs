/**
 * The API's HTTP surface (ADR-040).
 *
 * Because routing is a pure function over a plain request object, these tests
 * call the real route table with no listener and no port. What they cover is the
 * security-relevant behaviour of the edge: the security headers, the status a
 * failure maps to, the 405/404 distinction, and the promise that an anonymous
 * request is told it is anonymous rather than refused.
 *
 * The authentication flow itself is Phase 2's; this file pins the foundation it
 * will be built on.
 */
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, closeApp, type AppDependencies } from "../../apps/api/app";
import { createRouter } from "../../apps/api/routes";
import { loadConfig } from "../../apps/api/config";
import { Router } from "../../apps/api/http/router";
import {
  cookie,
  clearCookie,
  errorResponse,
  json,
  parseCookies,
  parseQuery,
  withSecurityHeaders,
} from "../../apps/api/http/http";
import { toErrorResponse } from "../../apps/api/http/errors";
import {
  BodyTooLargeError,
  correlationId,
  readBody,
} from "../../apps/api/http/node-server";
import {
  SESSION_COOKIE,
  createSessionToken,
  hashSessionToken,
  sessionIdOf,
} from "../../apps/api/context";
import { ApplicationError } from "../../src/application/errors";
import type { ServerRequest } from "../../apps/api/http/http";

let dependencies: AppDependencies;
let volume: string;

beforeAll(async () => {
  volume = await mkdtemp(path.join(tmpdir(), "sd-api-"));
  const config = loadConfig({
    NODE_ENV: "test",
    COOKIE_SECRET: "a".repeat(48),
    PUBLIC_URL: "http://localhost:4000",
    PROJECT_VOLUME: volume,
    PGLITE_DIR: "memory://",
  });
  dependencies = await createApp(config);
});

afterAll(async () => {
  await closeApp(dependencies);
  await rm(volume, { recursive: true, force: true });
});

/** Build a request, as the Node adapter would. */
function request(
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): ServerRequest {
  const raw = options.headers ?? {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw))
    headers[name.toLowerCase()] = value;
  const queryIndex = url.indexOf("?");
  return {
    method,
    path: queryIndex === -1 ? url : url.slice(0, queryIndex),
    query: parseQuery(queryIndex === -1 ? "" : url.slice(queryIndex)),
    headers,
    cookies: parseCookies(headers.cookie),
    body: options.body ?? null,
  };
}

describe("cookies", () => {
  it("parses a cookie header and ignores malformed pairs", () => {
    const cookies = parseCookies("a=1; b=two; broken; =empty; c=%20spaced");
    expect(cookies.a).toBe("1");
    expect(cookies.b).toBe("two");
    expect(cookies.c).toBe(" spaced");
    expect("broken" in cookies).toBe(false);
  });

  it("marks a session cookie HttpOnly, SameSite and Secure when asked", () => {
    const header = cookie(SESSION_COOKIE, "sid_x.y", {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAgeSeconds: 60,
    });
    expect(header.value).toMatch(/HttpOnly/);
    expect(header.value).toMatch(/Secure/);
    expect(header.value).toMatch(/SameSite=Lax/);
    expect(header.value).toMatch(/Max-Age=60/);
  });

  it("clears a cookie with an empty value and no lifetime", () => {
    expect(clearCookie(SESSION_COOKIE).value).toMatch(/Max-Age=0/);
  });
});

describe("session tokens", () => {
  it("mints a token whose public id is recoverable and whose hash is not the token", () => {
    const id = "00000000-0000-7000-8000-000000000001";
    const token = createSessionToken(id);
    expect(sessionIdOf(token)).toBe(id);
    const hash = hashSessionToken(token);
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a token that is not shaped like a session secret", () => {
    expect(sessionIdOf("nonsense")).toBeNull();
    expect(sessionIdOf("sid_notauuid.short")).toBeNull();
  });
});

describe("the route table", () => {
  it("answers 404 for an unknown path and 405 for a known path, wrong verb", async () => {
    const router = new Router();
    router.get("/api/me", async () => json(200, {}));
    expect((await router.handle(request("GET", "/nope"))).status).toBe(404);
    expect((await router.handle(request("POST", "/api/me"))).status).toBe(405);
  });

  it("captures route parameters", async () => {
    const router = new Router();
    router.get(
      "/api/projects/:projectId/resources/:resourceId",
      async (_r, params) => json(200, params),
    );
    const response = await router.handle(
      request("GET", "/api/projects/p1/resources/r2"),
    );
    expect(JSON.parse(response.body).resourceId).toBe("r2");
  });

  it("adds the security headers to every response, including an error", async () => {
    const router = new Router();
    router.get("/boom", async () => errorResponse(500, "internal_error", "no"));
    const response = await router.handle(request("GET", "/boom"));
    const names = response.headers.map((header) => header.name);
    expect(names).toContain("x-content-type-options");
    expect(names).toContain("cache-control");
  });

  it("does not duplicate a header a handler already set", () => {
    const response = withSecurityHeaders({
      status: 200,
      headers: [{ name: "cache-control", value: "public, max-age=60" }],
      body: "",
    });
    expect(
      response.headers.filter((header) => header.name === "cache-control"),
    ).toHaveLength(1);
  });
});

describe("failure mapping", () => {
  it("maps an ApplicationError to its status and code", () => {
    const response = toErrorResponse(
      new ApplicationError("conflict", "stale", { expectedRevision: 1 }),
      { requestId: "req-1" },
    );
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: "conflict",
        message: "stale",
        details: { expectedRevision: 1 },
      },
    });
  });

  it("adds a WWW-Authenticate challenge to a 401", () => {
    const response = toErrorResponse(
      new ApplicationError("unauthorized", "no"),
      {
        requestId: "req-1",
      },
    );
    expect(response.status).toBe(401);
    expect(response.headers.map((header) => header.name)).toContain(
      "www-authenticate",
    );
  });

  it("hides the detail of an unexpected failure and keeps its correlation id", () => {
    const seen: string[] = [];
    const response = toErrorResponse(new Error("connection string leaked"), {
      requestId: "req-9",
      onUnexpected: (_error, requestId) => seen.push(requestId),
    });
    expect(response.status).toBe(500);
    expect(response.body).not.toContain("connection string leaked");
    expect(JSON.parse(response.body).error.details).toEqual({
      requestId: "req-9",
    });
    expect(seen).toEqual(["req-9"]);
  });
});

describe("the API over its routes", () => {
  it("answers health with the database state", async () => {
    const router = createRouter(dependencies);
    const response = await router.handle(request("GET", "/healthz"));
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("ok");
    expect(body.database).toBe("ok");
  });

  it("answers an anonymous /api/me with a null user rather than a 401", async () => {
    const router = createRouter(dependencies);
    const response = await router.handle(request("GET", "/api/me"));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ user: null });
  });

  it("answers /api/me from a valid session cookie and never echoes the token", async () => {
    const user = await dependencies.users.findOrCreateByExternalIdentity({
      issuer: "https://idp.test",
      subject: "api-me-subject",
      displayName: "Ada",
      email: "ada@example.test",
    });
    const sessionId = "11111111-1111-7111-8111-111111111111";
    const token = createSessionToken(sessionId);
    await dependencies.sessions.create({
      id: sessionId,
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const router = createRouter(dependencies);
    const response = await router.handle(
      request("GET", "/api/me", {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.user.id).toBe(user.id);
    expect(body.user.displayName).toBe("Ada");
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain(hashSessionToken(token));
  });

  it("refuses a cookie whose secret does not match the stored hash", async () => {
    const user = await dependencies.users.findOrCreateByExternalIdentity({
      issuer: "https://idp.test",
      subject: "forged-subject",
      displayName: "Mallory",
      email: null,
    });
    const sessionId = "22222222-2222-7222-8222-222222222222";
    await dependencies.sessions.create({
      id: sessionId,
      userId: user.id,
      tokenHash: hashSessionToken(createSessionToken(sessionId)),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const router = createRouter(dependencies);
    const response = await router.handle(
      request("GET", "/api/me", {
        headers: {
          cookie: `${SESSION_COOKIE}=${createSessionToken(sessionId).replace(/\.\w+$/, ".forged-forged-forged")}`,
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ user: null });
  });

  it("treats an expired session as no session", async () => {
    const user = await dependencies.users.findOrCreateByExternalIdentity({
      issuer: "https://idp.test",
      subject: "expired-subject",
      displayName: "Old",
      email: null,
    });
    const sessionId = "33333333-3333-7333-8333-333333333333";
    const token = createSessionToken(sessionId);
    await dependencies.sessions.create({
      id: sessionId,
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() - 1000),
    });
    const router = createRouter(dependencies);
    const response = await router.handle(
      request("GET", "/api/me", {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    expect(JSON.parse(response.body)).toEqual({ user: null });
  });
});

describe("request plumbing", () => {
  it("reads a body and refuses one over the limit", async () => {
    const chunk = Buffer.from("abcd");
    async function* small() {
      yield chunk;
    }
    async function* large() {
      for (let index = 0; index < 10; index += 1) yield chunk;
    }
    expect(await readBody(small(), 100)).toBe("abcd");
    await expect(readBody(large(), 10)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("accepts a client correlation id and generates one otherwise", () => {
    const supplied = request("GET", "/", {
      headers: { "x-request-id": "trace-1" },
    });
    expect(correlationId(supplied)).toBe("trace-1");
    const generated = correlationId(
      request("GET", "/", {
        headers: { "x-request-id": "not valid because of spaces" },
      }),
    );
    expect(generated).toMatch(/^req_/);
  });
});
