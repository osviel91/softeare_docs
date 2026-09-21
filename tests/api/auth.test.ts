/**
 * Authentication (ADR-041).
 *
 * The mission's authentication list, as tests: no token is a 401, a malformed
 * token is a 401, an expired one is a 401, a revoked PAT-like credential is a
 * 401, a valid one is allowed, and a token for the wrong audience is rejected.
 * PATs arrive in Phase 5, so "credential" here is the session cookie — the same
 * verifier shape a PAT will go through.
 *
 * The provider is a real one (`test-provider.ts`): real keys, real signatures,
 * real PKCE. What is faked is only the network.
 */
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../apps/api/config";
import { closeApp, createApp, type AppDependencies } from "../../apps/api/app";
import { createRouter } from "../../apps/api/routes";
import { SESSION_COOKIE, sessionIdOf } from "../../apps/api/context";
import {
  LOGIN_COOKIE,
  decodeLoginState,
  encodeLoginState,
  safeReturnTo,
} from "../../apps/api/auth/login-state";
import {
  codeChallengeS256,
  createCodeVerifier,
  createOidcClient,
  decodeJws,
  verifyIdTokenClaims,
  verifySignature,
  OidcError,
} from "../../apps/api/auth/oidc";
import { createAuthRoutes, oidcClientFor } from "../../apps/api/auth/routes";
import {
  createTestProvider,
  createUnrelatedKeys,
  generateEcKeys,
  signIdToken,
  challengeFor,
  type TestProvider,
} from "./test-provider";
import {
  parseCookies,
  parseQuery,
  type ServerRequest,
} from "../../apps/api/http/http";

let dependencies: AppDependencies;
let volume: string;
let provider: TestProvider;

/**
 * A configuration whose OIDC settings are the test provider's.
 *
 * `oidcFetch` is the seam that keeps the *real* verification code in the test:
 * only the network is local, not the crypto.
 */
function testConfig() {
  return loadConfig(
    {
      NODE_ENV: "test",
      COOKIE_SECRET: "a".repeat(48),
      PUBLIC_URL: "http://localhost:4000",
      PROJECT_VOLUME: volume,
      PGLITE_DIR: "memory://",
      OIDC_ISSUER: provider.issuer,
      OIDC_CLIENT_ID: provider.clientId,
      OIDC_CLIENT_SECRET: provider.clientSecret,
      OIDC_REDIRECT_URI: provider.redirectUri,
    },
    { oidcFetch: provider.fetch },
  );
}

beforeAll(async () => {
  volume = await mkdtemp(path.join(tmpdir(), "sd-auth-"));
  provider = await createTestProvider();
  dependencies = await createApp(testConfig());
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
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
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

/** The value of one cookie in a response. */
function cookieFrom(
  headers: readonly { name: string; value: string }[],
  name: string,
): string | null {
  for (const header of headers) {
    if (header.name !== "set-cookie") continue;
    const [pair] = header.value.split(";");
    const index = pair.indexOf("=");
    if (index === -1) continue;
    if (pair.slice(0, index) !== name) continue;
    return decodeURIComponent(pair.slice(index + 1));
  }
  return null;
}

describe("the OIDC client", () => {
  const clientFor = (testProvider: TestProvider) =>
    createOidcClient({
      issuer: testProvider.issuer,
      clientId: testProvider.clientId,
      clientSecret: testProvider.clientSecret,
      redirectUri: testProvider.redirectUri,
      fetch: testProvider.fetch,
    });

  it("reads discovery and refuses an issuer that disagrees with it", async () => {
    const client = clientFor(provider);
    const metadata = await client.metadata();
    expect(metadata.token_endpoint).toBe(`${provider.issuer}/token`);

    const liar = createOidcClient({
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      redirectUri: provider.redirectUri,
      fetch: async (url) =>
        url.endsWith("openid-configuration")
          ? {
              ok: true,
              status: 200,
              async text() {
                return JSON.stringify({
                  issuer: "https://evil.test",
                  authorization_endpoint: "https://evil.test/authorize",
                  token_endpoint: "https://evil.test/token",
                  jwks_uri: "https://evil.test/jwks",
                });
              },
            }
          : provider.fetch(url),
    });
    await expect(liar.metadata()).rejects.toBeInstanceOf(OidcError);
  });

  it("builds an authorization URL with PKCE S256, state and nonce", async () => {
    const client = clientFor(provider);
    const transaction = {
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: createCodeVerifier(),
      returnTo: "/",
    };
    const url = new URL(await client.authorizationUrl(transaction));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(provider.clientId);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      codeChallengeS256(transaction.codeVerifier),
    );
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("nonce")).toBe("nonce-1");
  });

  it("exchanges a code and verifies the ID token", async () => {
    const client = clientFor(provider);
    const verifier = createCodeVerifier();
    const code = provider.issueCode({
      codeChallenge: codeChallengeS256(verifier),
      nonce: "nonce-ok",
      subject: "user-1",
      name: "Grace Hopper",
      email: "grace@example.test",
    });
    const identity = await client.exchange(code, {
      state: "s",
      nonce: "nonce-ok",
      codeVerifier: verifier,
      returnTo: "/",
    });
    expect(identity).toEqual({
      issuer: provider.issuer,
      subject: "user-1",
      displayName: "Grace Hopper",
      email: "grace@example.test",
    });
  });

  it("refuses a code whose PKCE verifier does not match", async () => {
    const client = clientFor(provider);
    const code = provider.issueCode({
      codeChallenge: challengeFor("the-real-verifier"),
      nonce: "nonce-pkce",
    });
    await expect(
      client.exchange(code, {
        state: "s",
        nonce: "nonce-pkce",
        codeVerifier: "a-different-verifier",
        returnTo: "/",
      }),
    ).rejects.toMatchObject({ kind: "token_request" });
  });

  it("refuses a token that names a signing key the provider no longer publishes", async () => {
    // Recreate the rotation the token names a *retired* key: the provider has
    // moved on, so a token must not be accepted by falling back to the new key.
    const rolled = await createTestProvider({ issuer: "https://roll.test" });
    const verifier = createCodeVerifier();
    const code = rolled.issueCode({
      codeChallenge: codeChallengeS256(verifier),
      nonce: "nonce-rotated",
    });

    // Sign the ID token with the retired key, then serve the new key set.
    const retired = await createUnrelatedKeys();
    const idToken = await signIdToken(
      {
        iss: rolled.issuer,
        aud: rolled.clientId,
        sub: "rotated-subject",
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: "nonce-rotated",
      },
      retired,
    );
    rolled.setIssuedToken(idToken);

    const client = createOidcClient({
      issuer: rolled.issuer,
      clientId: rolled.clientId,
      clientSecret: rolled.clientSecret,
      redirectUri: rolled.redirectUri,
      fetch: rolled.fetch,
    });
    await expect(
      client.exchange(code, {
        state: "s",
        nonce: "nonce-rotated",
        codeVerifier: verifier,
        returnTo: "/",
      }),
    ).rejects.toBeInstanceOf(OidcError);
  });

  it("accepts an ES256 token as well as RS256", async () => {
    const ecKeys = await generateEcKeys();
    const ecProvider = await createTestProvider({
      issuer: "https://ec.test",
      keys: ecKeys,
    });
    const client = clientFor(ecProvider);
    const verifier = createCodeVerifier();
    const code = ecProvider.issueCode({
      codeChallenge: codeChallengeS256(verifier),
      nonce: "nonce-ec",
      subject: "ec-user",
    });
    const identity = await client.exchange(code, {
      state: "s",
      nonce: "nonce-ec",
      codeVerifier: verifier,
      returnTo: "/",
    });
    expect(identity.subject).toBe("ec-user");
  });
});

describe("ID token verification", () => {
  const expectations = {
    issuer: "https://idp.test",
    audience: "test-client",
    nonce: "nonce-1",
  };

  it("refuses a token for a different audience", async () => {
    const token = await signIdToken(
      {
        iss: "https://idp.test",
        aud: "another-application",
        sub: "s",
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: "nonce-1",
      },
      provider.keys,
    );
    const payload = await verifySignature(
      token,
      [provider.keys.jwk],
      ["RS256"],
    );
    expect(() => verifyIdTokenClaims(payload, expectations)).toThrow(
      /not issued for this/,
    );
  });

  it("refuses a token from a different issuer", async () => {
    const token = await signIdToken(
      {
        iss: "https://other-idp.test",
        aud: "test-client",
        sub: "s",
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: "nonce-1",
      },
      provider.keys,
    );
    const payload = await verifySignature(
      token,
      [provider.keys.jwk],
      ["RS256"],
    );
    expect(() => verifyIdTokenClaims(payload, expectations)).toThrow(
      /issued by/,
    );
  });

  it("refuses an expired token", async () => {
    const token = await signIdToken(
      {
        iss: "https://idp.test",
        aud: "test-client",
        sub: "s",
        exp: Math.floor(Date.now() / 1000) - 3600,
        nonce: "nonce-1",
      },
      provider.keys,
    );
    const payload = await verifySignature(
      token,
      [provider.keys.jwk],
      ["RS256"],
    );
    expect(() => verifyIdTokenClaims(payload, expectations)).toThrow(/expired/);
  });

  it("refuses a token whose nonce does not match this login", async () => {
    const token = await signIdToken(
      {
        iss: "https://idp.test",
        aud: "test-client",
        sub: "s",
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: "some-other-nonce",
      },
      provider.keys,
    );
    const payload = await verifySignature(
      token,
      [provider.keys.jwk],
      ["RS256"],
    );
    expect(() => verifyIdTokenClaims(payload, expectations)).toThrow(/nonce/);
  });

  it("accepts a token whose audience is an array containing this client", async () => {
    const token = await signIdToken(
      {
        iss: "https://idp.test",
        aud: ["another", "test-client"],
        sub: "s",
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: "nonce-1",
      },
      provider.keys,
    );
    const payload = await verifySignature(
      token,
      [provider.keys.jwk],
      ["RS256"],
    );
    expect(verifyIdTokenClaims(payload, expectations).subject).toBe("s");
  });

  it("refuses an unsigned or HMAC-signed token outright", async () => {
    const token = await signIdToken(
      {
        iss: "https://idp.test",
        aud: "test-client",
        sub: "s",
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: "nonce-1",
      },
      provider.keys,
    );
    await expect(
      verifySignature(token, [provider.keys.jwk], ["none"]),
    ).rejects.toBeInstanceOf(OidcError);
    // The header says RS256, so an HS256 allow-list must refuse it before any
    // key material is consulted.
    await expect(
      verifySignature(
        token,
        [provider.keys.jwk],
        ["HS256"],
        "the-client-secret",
      ),
    ).rejects.toMatchObject({ kind: "invalid_token" });
  });

  it("reports a malformed token as invalid rather than throwing a parse error", async () => {
    await expect(
      verifySignature("not.a.jwt", [provider.keys.jwk], ["RS256"]),
    ).rejects.toBeInstanceOf(OidcError);
    expect(() => decodeJws("only-one-part")).toThrow(OidcError);
  });

  it("uses the subject as a display name when the provider gives none", async () => {
    const token = await signIdToken(
      {
        iss: "https://idp.test",
        aud: "test-client",
        sub: "subject-only",
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: "nonce-1",
      },
      provider.keys,
    );
    const payload = await verifySignature(
      token,
      [provider.keys.jwk],
      ["RS256"],
    );
    const identity = verifyIdTokenClaims(payload, expectations);
    expect(identity.displayName).toBe("subject-only");
    expect(identity.email).toBeNull();
  });
});

describe("the login-state cookie", () => {
  const secret = "s".repeat(48);
  const transaction = {
    state: "state-1",
    nonce: "nonce-1",
    codeVerifier: "verifier-1",
    returnTo: "/projects",
  };

  it("round-trips a transaction", () => {
    const encoded = encodeLoginState(secret, transaction);
    expect(decodeLoginState(secret, encoded)).toEqual(transaction);
  });

  it("refuses a tampered payload and a wrong secret", () => {
    const encoded = encodeLoginState(secret, transaction);
    const [payload, signature] = encoded.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...transaction, codeVerifier: "attacker-verifier" }),
      "utf8",
    ).toString("base64url");
    expect(decodeLoginState(secret, `${forged}.${signature}`)).toBeNull();
    expect(decodeLoginState("t".repeat(48), encoded)).toBeNull();
    expect(decodeLoginState(secret, `${payload}.`)).toBeNull();
    expect(decodeLoginState(secret, "garbage")).toBeNull();
    expect(decodeLoginState(secret, undefined)).toBeNull();
  });

  it("refuses an expired transaction", () => {
    const encoded = encodeLoginState(secret, transaction, 1000);
    expect(decodeLoginState(secret, encoded, 1000 + 601)).toBeNull();
  });

  it("keeps a post-login destination on this site", () => {
    expect(safeReturnTo("/projects")).toBe("/projects");
    expect(safeReturnTo(undefined)).toBe("/");
    for (const hostile of [
      "https://evil.test/",
      "//evil.test/",
      "/\\evil.test",
      "javascript:alert(1)",
      "projects",
    ]) {
      expect(safeReturnTo(hostile)).toBe("/");
    }
  });
});

describe("the authentication routes", () => {
  it("starts a login with a signed state cookie and a PKCE challenge", async () => {
    const router = createRouter(dependencies);
    const response = await router.handle(
      request("GET", "/auth/login?returnTo=/projects"),
    );
    expect(response.status).toBe(302);
    const location = response.headers.find(
      (header) => header.name === "location",
    );
    const url = new URL(location?.value ?? "");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const stateCookie = cookieFrom(response.headers, LOGIN_COOKIE);
    expect(stateCookie).not.toBeNull();
    const transaction = decodeLoginState("a".repeat(48), stateCookie ?? "");
    expect(transaction).not.toBeNull();
    expect(transaction?.returnTo).toBe("/projects");
    expect(codeChallengeS256(transaction?.codeVerifier ?? "")).toBe(
      url.searchParams.get("code_challenge"),
    );
    expect(url.searchParams.get("state")).toBe(transaction?.state);
    expect(url.searchParams.get("nonce")).toBe(transaction?.nonce);

    const setCookie = response.headers.find(
      (header) => header.name === "set-cookie",
    );
    expect(setCookie?.value).toMatch(/HttpOnly/);
    expect(setCookie?.value).toMatch(/SameSite=Lax/);
  });

  it("completes a login and issues a session cookie", async () => {
    const router = createRouter(dependencies);
    const start = await router.handle(
      request("GET", "/auth/login?returnTo=/dashboard"),
    );
    const state = cookieFrom(start.headers, LOGIN_COOKIE) ?? "";
    const transaction = decodeLoginState("a".repeat(48), state);
    const code = provider.issueCode({
      codeChallenge: codeChallengeS256(transaction?.codeVerifier ?? ""),
      nonce: transaction?.nonce ?? "",
      subject: "route-subject",
      name: "Route User",
    });

    const callback = await router.handle(
      request(
        "GET",
        `/auth/callback?code=${code}&state=${transaction?.state}`,
        {
          headers: { cookie: `${LOGIN_COOKIE}=${encodeURIComponent(state)}` },
        },
      ),
    );
    expect(callback.status).toBe(303);
    expect(
      callback.headers.find((header) => header.name === "location")?.value,
    ).toBe("/dashboard");

    const session = cookieFrom(callback.headers, SESSION_COOKIE);
    expect(session).not.toBeNull();
    expect(session?.startsWith("sid_")).toBe(true);

    // The session cookie works, and the login cookie is cleared.
    const me = await router.handle(
      request("GET", "/api/me", {
        headers: {
          cookie: `${SESSION_COOKIE}=${encodeURIComponent(session ?? "")}`,
        },
      }),
    );
    expect(JSON.parse(me.body).user).toMatchObject({
      displayName: "Route User",
      authType: "session",
    });
    expect(
      callback.headers
        .filter((header) => header.name === "set-cookie")
        .some((header) => header.value.startsWith(`${LOGIN_COOKIE}=;`)),
    ).toBe(true);
  });

  it("refuses a callback with no login state", async () => {
    const router = createRouter(dependencies);
    const response = await router.handle(
      request("GET", "/auth/callback?code=x&state=y"),
    );
    expect(response.status).toBe(303);
    expect(response.headers.find((h) => h.name === "location")?.value).toBe(
      "/?auth=failed",
    );
  });

  it("refuses a callback whose state does not match the cookie", async () => {
    const router = createRouter(dependencies);
    const start = await router.handle(request("GET", "/auth/login"));
    const state = cookieFrom(start.headers, LOGIN_COOKIE) ?? "";
    const response = await router.handle(
      request("GET", "/auth/callback?code=x&state=wrong-state", {
        headers: { cookie: `${LOGIN_COOKIE}=${encodeURIComponent(state)}` },
      }),
    );
    expect(response.headers.find((h) => h.name === "location")?.value).toBe(
      "/?auth=failed",
    );
  });

  it("refuses a callback the provider reports as failed, without echoing it", async () => {
    const router = createRouter(dependencies);
    const start = await router.handle(request("GET", "/auth/login"));
    const state = cookieFrom(start.headers, LOGIN_COOKIE) ?? "";
    const transaction = decodeLoginState("a".repeat(48), state);
    const response = await router.handle(
      request(
        "GET",
        `/auth/callback?error=access_denied&error_description=secret-detail&state=${transaction?.state}`,
        { headers: { cookie: `${LOGIN_COOKIE}=${encodeURIComponent(state)}` } },
      ),
    );
    expect(response.status).toBe(303);
    expect(response.body).not.toContain("secret-detail");
    expect(response.headers.find((h) => h.name === "location")?.value).toBe(
      "/?auth=failed",
    );
  });

  it("answers 503 when sign-in is not configured", async () => {
    const unconfigured = await createApp(
      loadConfig({
        NODE_ENV: "test",
        COOKIE_SECRET: "b".repeat(48),
        PUBLIC_URL: "http://localhost:4000",
        PROJECT_VOLUME: volume,
        PGLITE_DIR: "memory://",
      }),
    );
    try {
      const router = createRouter(unconfigured);
      const response = await router.handle(request("GET", "/auth/login"));
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body).error.code).toBe("unavailable");
      expect(oidcClientFor(unconfigured)).toBeNull();
    } finally {
      await closeApp(unconfigured);
    }
  });

  it("revokes the session on logout and clears the cookie", async () => {
    const router = createRouter(dependencies);
    const user = await dependencies.users.findOrCreateByExternalIdentity({
      issuer: provider.issuer,
      subject: "logout-subject",
      displayName: "Logout User",
      email: null,
    });
    const sessionId = "44444444-4444-7444-8444-444444444444";
    const { createSessionToken, hashSessionToken } =
      await import("../../apps/api/context");
    const token = createSessionToken(sessionId);
    await dependencies.sessions.create({
      id: sessionId,
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await router.handle(
      request("POST", "/auth/logout", {
        headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
      }),
    );
    expect(response.status).toBe(204);
    expect(
      response.headers.find((header) => header.name === "set-cookie")?.value,
    ).toMatch(`${SESSION_COOKIE}=;`);

    const record = await dependencies.sessions.findById(sessionId);
    expect(record?.revokedAt).not.toBeNull();

    // A revoked session is refused on the next request.
    const me = await router.handle(
      request("GET", "/api/me", {
        headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
      }),
    );
    expect(JSON.parse(me.body)).toEqual({ user: null });
  });

  it("maps a missing session to 401 on a protected route", async () => {
    const router = createRouter(dependencies);
    const response = await router.handle(request("GET", "/api/projects"));
    expect(response.status).toBe(401);
    expect(response.headers.map((header) => header.name)).toContain(
      "www-authenticate",
    );
  });

  it("maps a malformed session cookie to 401", async () => {
    const router = createRouter(dependencies);
    const response = await router.handle(
      request("GET", "/api/projects", {
        headers: { cookie: `${SESSION_COOKIE}=not-a-session-token` },
      }),
    );
    expect(response.status).toBe(401);
    expect(sessionIdOf("not-a-session-token")).toBeNull();
  });

  it("maps an expired session to 401", async () => {
    const user = await dependencies.users.findOrCreateByExternalIdentity({
      issuer: provider.issuer,
      subject: "expired-route-subject",
      displayName: "Expired",
      email: null,
    });
    const sessionId = "55555555-5555-7555-8555-555555555555";
    const { createSessionToken, hashSessionToken } =
      await import("../../apps/api/context");
    const token = createSessionToken(sessionId);
    await dependencies.sessions.create({
      id: sessionId,
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() - 1000),
    });
    const router = createRouter(dependencies);
    const response = await router.handle(
      request("GET", "/api/projects", {
        headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("keeps the login routes reachable from the routes module too", async () => {
    const routes = createAuthRoutes(dependencies);
    const response = await routes.login(
      request("GET", "/auth/login?returnTo=//evil.test"),
    );
    const location = response.headers.find(
      (header) => header.name === "location",
    );
    const transaction = decodeLoginState(
      "a".repeat(48),
      cookieFrom(response.headers, LOGIN_COOKIE) ?? "",
    );
    expect(transaction?.returnTo).toBe("/");
    expect(location?.value.startsWith(`${provider.issuer}/authorize`)).toBe(
      true,
    );
  });
});
