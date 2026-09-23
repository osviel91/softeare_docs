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
let provider: TestProvider;
let volume: string;

beforeAll(async () => {
  volume = await mkdtemp(path.join(tmpdir(), "sd-workspace-api-"));
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
});

afterAll(async () => {
  await closeApp(dependencies);
  await rm(volume, { recursive: true, force: true });
});

function request(
  method: string,
  url: string,
  cookie: string,
  body?: unknown,
): ServerRequest {
  const queryIndex = url.indexOf("?");
  return {
    method,
    path: queryIndex === -1 ? url : url.slice(0, queryIndex),
    query: parseQuery(queryIndex === -1 ? "" : url.slice(queryIndex)),
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    cookies: parseCookies(cookie),
    body: body === undefined ? null : JSON.stringify(body),
  };
}

async function signIn(): Promise<{ cookie: string; userId: string }> {
  const user = await dependencies.users.findOrCreateByExternalIdentity({
    issuer: provider.issuer,
    subject: crypto.randomUUID(),
    displayName: "Ada",
    email: "ada@example.test",
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

describe("workspace lifecycle API", () => {
  it("creates, renames and deletes a non-default workspace", async () => {
    const router = createRouter(dependencies);
    const { cookie } = await signIn();
    const created = await router.handle(
      request("POST", "/api/workspaces", cookie, { name: "Engineering" }),
    );
    expect(created.status).toBe(201);
    const workspace = JSON.parse(created.body).workspace as {
      id: string;
      isDefault: boolean;
    };
    expect(workspace.isDefault).toBe(false);

    const renamed = await router.handle(
      request("PATCH", `/api/workspaces/${workspace.id}`, cookie, {
        name: "Platform",
      }),
    );
    expect(renamed.status).toBe(200);
    expect(JSON.parse(renamed.body).workspace.name).toBe("Platform");

    const deleted = await router.handle(
      request("DELETE", `/api/workspaces/${workspace.id}`, cookie),
    );
    expect(deleted.status).toBe(204);
  });

  it("refuses deletion of the default workspace", async () => {
    const router = createRouter(dependencies);
    const { cookie, userId } = await signIn();
    const deleted = await router.handle(
      request("DELETE", `/api/workspaces/${userId}`, cookie),
    );
    expect(deleted.status).toBe(422);
  });
});
