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
import {
  SESSION_COOKIE,
  createSessionToken,
  hashSessionToken,
  sessionIdOf,
} from "../../apps/api/context";
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
  verifyIdTokenClaims,
  OidcError,
  type OidcClient,
  type VerifiedIdentity,
} from "../../apps/api/auth/oidc";
import { createAuthRoutes, oidcClientFor } from "../../apps/api/auth/routes";
import { SignJWT, decodeJwt } from "jose";
import {
  createTestProvider,
  createUnrelatedKeys,
  generateEcKeys,
  generateRsaKeys,
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

  /**
   * Run one full exchange through the public client path.
   *
   * Every negative case goes through `exchange` rather than through a JOSE
   * helper, so what is asserted is the behaviour a browser would see. `claims`
   * overrides what the provider signs, and `idToken` replaces the token
   * wholesale for cases (a forged signature, a foreign algorithm) that the
   * provider's own signer deliberately cannot produce.
   */
  async function attempt(
    testProvider: TestProvider,
    client: OidcClient,
    input: {
      nonce: string;
      subject?: string;
      claims?: Record<string, unknown>;
      idToken?: string;
    },
  ): Promise<VerifiedIdentity> {
    const verifier = createCodeVerifier();
    const code = testProvider.issueCode({
      codeChallenge: codeChallengeS256(verifier),
      nonce: input.nonce,
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.claims === undefined ? {} : { claims: input.claims }),
    });
    if (input.idToken !== undefined) testProvider.setIssuedToken(input.idToken);
    try {
      return await client.exchange(code, {
        state: "s",
        nonce: input.nonce,
        codeVerifier: verifier,
        returnTo: "/",
      });
    } finally {
      testProvider.setIssuedToken(null);
    }
  }

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

  it("accepts a rotated key by refetching the provider's key set", async () => {
    // A rotation test only means something once the previous key set has been
    // cached, so this does one successful exchange first. The second token is
    // signed with a key the client has never seen: the unknown-`kid` path must
    // fetch again rather than fail until a restart.
    const rotated = await createTestProvider({
      issuer: "https://rotate.test",
    });
    const client = clientFor(rotated);

    const firstVerifier = createCodeVerifier();
    const firstCode = rotated.issueCode({
      codeChallenge: codeChallengeS256(firstVerifier),
      nonce: "nonce-before-rotation",
      subject: "before-rotation",
    });
    const first = await client.exchange(firstCode, {
      state: "s",
      nonce: "nonce-before-rotation",
      codeVerifier: firstVerifier,
      returnTo: "/",
    });
    expect(first.subject).toBe("before-rotation");

    rotated.rotateKeys(await generateRsaKeys());

    const secondVerifier = createCodeVerifier();
    const secondCode = rotated.issueCode({
      codeChallenge: codeChallengeS256(secondVerifier),
      nonce: "nonce-after-rotation",
      subject: "after-rotation",
    });
    const second = await client.exchange(secondCode, {
      state: "s",
      nonce: "nonce-after-rotation",
      codeVerifier: secondVerifier,
      returnTo: "/",
    });
    expect(second.subject).toBe("after-rotation");
  });

  it("refuses a token signed by a key unrelated to the published one", async () => {
    // The header names the *published* key, so the lookup succeeds and only the
    // signature check can refuse it — which is the case being tested.
    const unrelated = await createUnrelatedKeys();
    const forged = await new SignJWT({
      iss: provider.issuer,
      aud: provider.clientId,
      sub: "forged",
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce: "nonce-signature",
    })
      .setProtectedHeader({
        alg: "RS256",
        typ: "JWT",
        kid: provider.keys.kid,
      })
      .sign(unrelated.privateKey);

    await expect(
      attempt(provider, clientFor(provider), {
        nonce: "nonce-signature",
        idToken: forged,
      }),
    ).rejects.toMatchObject({ kind: "invalid_token" });
  });

  it("refuses an expired token", async () => {
    await expect(
      attempt(provider, clientFor(provider), {
        nonce: "nonce-expired",
        claims: { exp: Math.floor(Date.now() / 1000) - 3600 },
      }),
    ).rejects.toMatchObject({ kind: "invalid_token" });
  });

  it("refuses a token from a different issuer", async () => {
    await expect(
      attempt(provider, clientFor(provider), {
        nonce: "nonce-issuer",
        claims: { iss: "https://other-idp.test" },
      }),
    ).rejects.toMatchObject({ kind: "invalid_token" });
  });

  it("refuses a token for a different audience", async () => {
    await expect(
      attempt(provider, clientFor(provider), {
        nonce: "nonce-audience",
        claims: { aud: "another-application" },
      }),
    ).rejects.toMatchObject({ kind: "invalid_token" });
  });

  it("refuses a token that is not valid yet", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      attempt(provider, clientFor(provider), {
        nonce: "nonce-not-yet",
        claims: { nbf: now + 3600, exp: now + 7200 },
      }),
    ).rejects.toMatchObject({ kind: "invalid_token" });
  });

  it("reports an unreadable key set as a discovery failure", async () => {
    // The token exchange succeeds; only the JWKS fetch fails. That is the
    // provider's problem, so it must surface as `discovery`, not as a bad token.
    const broken = await createTestProvider({ issuer: "https://broken.test" });
    const client = createOidcClient({
      issuer: broken.issuer,
      clientId: broken.clientId,
      clientSecret: broken.clientSecret,
      redirectUri: broken.redirectUri,
      fetch: async (url, init) =>
        url.endsWith("/jwks")
          ? {
              ok: false,
              status: 503,
              async text() {
                return "unavailable";
              },
            }
          : broken.fetch(url, init),
    });

    await expect(
      attempt(broken, client, { nonce: "nonce-discovery" }),
    ).rejects.toMatchObject({ kind: "discovery" });
  });

  it("refuses a token without a subject", async () => {
    await expect(
      attempt(provider, clientFor(provider), {
        nonce: "nonce-subject",
        claims: { sub: undefined },
      }),
    ).rejects.toMatchObject({ kind: "invalid_token" });
  });

  it("refuses a token whose header names an algorithm off the allow-list", async () => {
    // A real HS256 token, signed with the client secret: the classic algorithm
    // confusion attempt. The allow-list must refuse it before the token's own
    // header can select HMAC.
    const hmac = await new SignJWT({
      iss: provider.issuer,
      aud: provider.clientId,
      sub: "hmac",
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce: "nonce-algorithm",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(new TextEncoder().encode(provider.clientSecret));

    await expect(
      attempt(provider, clientFor(provider), {
        nonce: "nonce-algorithm",
        idToken: hmac,
      }),
    ).rejects.toMatchObject({ kind: "invalid_token" });
  });

  it("reports a malformed token as invalid rather than a parse error", async () => {
    await expect(
      attempt(provider, clientFor(provider), {
        nonce: "nonce-malformed",
        idToken: "not.a.jwt",
      }),
    ).rejects.toMatchObject({ kind: "invalid_token" });
  });
});

describe("local account authentication", () => {
  it("registers pending, blocks pending login, then logs in after approval", async () => {
    const router = createRouter(dependencies);
    const email = `local-${Date.now()}@example.test`;
    const password = "a-secure-password-123";
    const register = await router.handle(
      request("POST", "/auth/register", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.toUpperCase(),
          password,
          displayName: "Local Ada",
        }),
      }),
    );
    expect(register.status).toBe(202);

    const pendingLogin = await router.handle(
      request("POST", "/auth/local-login", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
    expect(pendingLogin.status).toBe(403);

    const local = await dependencies.users.findLocalByEmail(email);
    expect(local?.user.status).toBe("PENDING");
    const pendingEvents = await dependencies.audit.listForUser(
      local!.user.id,
      10,
    );
    expect(pendingEvents.map((event) => event.action)).toEqual([
      "login.rejected",
      "account.registered",
    ]);
    expect(pendingEvents[0].detail).toEqual({ reason: "account_not_active" });
    await dependencies.users.setStatus(local!.user.id, "ACTIVE");

    const login = await router.handle(
      request("POST", "/auth/local-login", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
    expect(login.status).toBe(200);
    const session = cookieFrom(login.headers, SESSION_COOKIE);
    expect(session).not.toBeNull();

    const me = await router.handle(
      request("GET", "/api/me", {
        headers: { cookie: `${SESSION_COOKIE}=${session}` },
      }),
    );
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body).user.email).toBe(email);
  });

  it("audits platform-admin account activation and suspension", async () => {
    const router = createRouter(dependencies);
    const admin = await dependencies.users.findOrCreateByExternalIdentity({
      issuer: provider.issuer,
      subject: `audit-admin-${Date.now()}`,
      displayName: "Audit Admin",
      email: null,
    });
    await dependencies.sql.query(
      "UPDATE users SET platform_admin = true WHERE id = $1",
      [admin.id],
    );
    const token = createSessionToken(crypto.randomUUID());
    await dependencies.sessions.create({
      id: sessionIdOf(token)!,
      userId: admin.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const target = await dependencies.users.findOrCreateByExternalIdentity({
      issuer: provider.issuer,
      subject: `audit-target-${Date.now()}`,
      displayName: "Audit Target",
      email: null,
    });
    await dependencies.users.setStatus(target.id, "PENDING");

    for (const status of ["ACTIVE", "SUSPENDED"] as const) {
      const response = await router.handle(
        request("PATCH", `/api/admin/users/${target.id}`, {
          headers: {
            cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ status }),
        }),
      );
      expect(response.status).toBe(200);
    }

    const events = await dependencies.audit.listForUser(target.id, 10);
    expect(events.map((event) => event.action)).toEqual([
      "account.suspended",
      "account.activated",
    ]);
    expect(events.every((event) => event.actorId === admin.id)).toBe(true);
  });
});

describe("ID token claim checking", () => {
  // Read lazily: the provider is created in `beforeAll`, after collection.
  const expectations = () => ({
    issuer: provider.issuer,
    audience: provider.clientId,
    nonce: "nonce-1",
  });

  /** A real provider-signed token, decoded with jose to feed the claim check. */
  async function payloadFor(
    claims: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const token = await signIdToken(claims, provider.keys);
    return decodeJwt(token) as Record<string, unknown>;
  }

  it("refuses a token whose nonce does not match this login", async () => {
    const payload = await payloadFor({
      iss: provider.issuer,
      aud: provider.clientId,
      sub: "s",
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce: "some-other-nonce",
    });
    expect(() => verifyIdTokenClaims(payload, expectations())).toThrow(/nonce/);
  });

  it("accepts a token whose audience is an array containing this client", async () => {
    const payload = await payloadFor({
      iss: provider.issuer,
      aud: ["another", provider.clientId],
      sub: "s",
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce: "nonce-1",
    });
    expect(verifyIdTokenClaims(payload, expectations()).subject).toBe("s");
  });

  it("uses the subject as a display name when the provider gives none", async () => {
    const payload = await payloadFor({
      iss: provider.issuer,
      aud: provider.clientId,
      sub: "subject-only",
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce: "nonce-1",
    });
    const identity = verifyIdTokenClaims(payload, expectations());
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

  it("audits and refuses a suspended OIDC account before issuing a session", async () => {
    const router = createRouter(dependencies);
    const subject = `suspended-oidc-${Date.now()}`;
    const user = await dependencies.users.findOrCreateByExternalIdentity({
      issuer: provider.issuer,
      subject,
      displayName: "Suspended OIDC",
      email: null,
    });
    await dependencies.users.setStatus(user.id, "SUSPENDED");
    const start = await router.handle(request("GET", "/auth/login"));
    const state = cookieFrom(start.headers, LOGIN_COOKIE) ?? "";
    const transaction = decodeLoginState("a".repeat(48), state);
    const code = provider.issueCode({
      codeChallenge: codeChallengeS256(transaction?.codeVerifier ?? ""),
      nonce: transaction?.nonce ?? "",
      subject,
    });

    const callback = await router.handle(
      request(
        "GET",
        `/auth/callback?code=${code}&state=${transaction?.state}`,
        { headers: { cookie: `${LOGIN_COOKIE}=${encodeURIComponent(state)}` } },
      ),
    );

    expect(callback.status).toBe(303);
    expect(cookieFrom(callback.headers, SESSION_COOKIE)).toBeNull();
    const events = await dependencies.audit.listForUser(user.id, 10);
    expect(events[0]).toMatchObject({
      action: "login.rejected",
      authType: "oauth",
      detail: { reason: "account_not_active" },
    });
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

/**
 * Session security (mission item 20).
 *
 * A session is the only credential a browser holds, so its cookie attributes,
 * its rotation on sign-in, and its invalidation on sign-out are security
 * behaviour rather than browser trivia. Each of these is a property an operator
 * would assume; asserting them here is what stops a refactor from quietly
 * dropping one.
 */
describe("session security", () => {
  /** Run a complete login and return the raw `Set-Cookie` line. */
  async function loginCookie(
    subject: string,
    config = dependencies.config,
  ): Promise<string> {
    const routes = createAuthRoutes(
      { ...dependencies, config },
      oidcClientFor(dependencies),
    );
    const start = await routes.login(request("GET", "/auth/login"));
    const loginCookieValue = cookieFrom(start.headers, LOGIN_COOKIE) ?? "";
    const transaction = decodeLoginState(config.cookieSecret, loginCookieValue);
    const code = provider.issueCode({
      codeChallenge: codeChallengeS256(transaction?.codeVerifier ?? ""),
      nonce: transaction?.nonce ?? "",
      subject,
    });
    const callback = await routes.callback(
      request(
        "GET",
        `/auth/callback?code=${code}&state=${transaction?.state}`,
        {
          headers: {
            cookie: `${LOGIN_COOKIE}=${encodeURIComponent(loginCookieValue)}`,
          },
        },
      ),
    );
    const header = callback.headers.find(
      (candidate) =>
        candidate.name === "set-cookie" &&
        candidate.value.startsWith(`${SESSION_COOKIE}=`),
    );
    if (header === undefined) throw new Error("No session cookie was issued.");
    return header.value;
  }

  it("marks the session cookie HttpOnly, Lax, path-scoped and expiring", async () => {
    const line = await loginCookie("cookie-attributes");
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Lax");
    expect(line).toContain("Path=/");
    expect(line).toMatch(/Max-Age=\d+/);
    // A loopback HTTP deployment cannot set Secure without breaking sign-in;
    // every other deployment must.
    expect(line).not.toContain("Secure");
  });

  it("adds Secure when the deployment is not loopback HTTP", async () => {
    const line = await loginCookie("secure-cookie", {
      ...dependencies.config,
      secureCookies: true,
    });
    expect(line).toContain("Secure");
  });

  it("rotates the session on every login, so a fixed session cannot be planted", async () => {
    const first = await loginCookie("rotation-subject");
    const second = await loginCookie("rotation-subject");
    const idOf = (line: string): string | null =>
      sessionIdOf(
        decodeURIComponent(line.split(";")[0].slice(SESSION_COOKIE.length + 1)),
      );

    expect(idOf(first)).not.toBeNull();
    expect(idOf(second)).not.toBeNull();
    // A new session row per login: an identifier an attacker already knows is
    // never promoted into a live session.
    expect(idOf(first)).not.toBe(idOf(second));
  });
});
