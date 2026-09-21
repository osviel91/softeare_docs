/**
 * A local identity provider for tests (ADR-041).
 *
 * The authentication code talks to a real OIDC provider over HTTP and verifies
 * real signatures, so a test double that returns canned strings would prove
 * almost nothing. This is a small but *real* provider: it generates a signing
 * key, serves a discovery document and a JWKS, and signs genuine ID tokens with
 * the platform's Web Crypto — the same API the verifier uses, but with a
 * different key, which is the arrangement a test needs.
 *
 * It also enforces PKCE: a token request whose `code_verifier` does not hash to
 * the `code_challenge` from the authorization URL is refused, so the client's
 * PKCE implementation is exercised rather than ignored.
 */
import { createHash, randomUUID } from "node:crypto";

/** A generated signing identity. */
export interface TestProviderKeys {
  /** The private key, for signing. */
  privateKey: CryptoKey;
  /** The public JWK, as a JWKS would publish it. */
  jwk: Record<string, unknown>;
  alg: "RS256" | "ES256";
  /**
   * A key identifier derived from the key material.
   *
   * Unique per key rather than constant, so a rotated key set is genuinely a
   * *different* key set: a verifier that looks the token's `kid` up finds
   * nothing, which is what makes a rotation test meaningful.
   */
  kid: string;
  /** The ID-token lifetime this key's provider issues, in seconds. */
  ttlSeconds: number;
}

/** A stable key id derived from the JWK's own material. */
function keyIdOf(alg: string, jwk: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${alg}:${String(jwk.x ?? jwk.n ?? "")}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** Generate an RSA signing key and its public JWK. */
export async function generateRsaKeys(): Promise<TestProviderKeys> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<
    string,
    unknown
  >;
  const kid = keyIdOf("RS256", jwk);
  return {
    privateKey: pair.privateKey,
    jwk: { ...jwk, alg: "RS256", use: "sig", kid },
    alg: "RS256",
    kid,
    ttlSeconds: 300,
  };
}

/** Generate an EC (P-256) signing key and its public JWK. */
export async function generateEcKeys(): Promise<TestProviderKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<
    string,
    unknown
  >;
  const kid = keyIdOf("ES256", jwk);
  return {
    privateKey: pair.privateKey,
    jwk: { ...jwk, alg: "ES256", use: "sig", kid },
    alg: "ES256",
    kid,
    ttlSeconds: 300,
  };
}

/** Base64url encode. */
function base64url(input: Uint8Array | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign a claim set into a compact JWS with the given key. */
export async function signIdToken(
  claims: Record<string, unknown>,
  keys: TestProviderKeys,
): Promise<string> {
  const header = { alg: keys.alg, typ: "JWT", kid: keys.kid };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const data = new TextEncoder().encode(signingInput);
  const signature =
    keys.alg === "ES256"
      ? await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          keys.privateKey,
          data,
        )
      : await crypto.subtle.sign(
          { name: "RSASSA-PKCS1-v1_5" },
          keys.privateKey,
          data,
        );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

/** What one issued authorization code remembers. */
interface IssuedCode {
  codeChallenge: string;
  nonce: string;
  claims: Record<string, unknown>;
}

/** A test provider, with the fetch function the client should use. */
export interface TestProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  keys: TestProviderKeys;
  /** The fetch implementation to hand to `createOidcClient`. */
  fetch: (
    url: string,
    init?: { method?: string; body?: string },
  ) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
  /** Issue a code for a subject, recording the PKCE challenge it must match. */
  issueCode(input: {
    codeChallenge: string;
    nonce: string;
    subject?: string;
    name?: string;
    email?: string | null;
    /** Overrides merged into the claims, for negative tests. */
    claims?: Record<string, unknown>;
  }): string;
  /** How many token requests were made, for asserting a single exchange. */
  tokenRequests(): number;
  /** Replace the served key set, to test key rotation. */
  rotateKeys(keys: TestProviderKeys): void;
  /**
   * Serve a fixed ID token for the next exchange instead of signing one.
   *
   * The only way to test a *retired* signing key: the provider must return a
   * token it would no longer sign, which is exactly what a client sees when a
   * provider has rotated its key between issuance and verification.
   */
  setIssuedToken(token: string | null): void;
}

/** Build a test provider. */
export async function createTestProvider(
  options: { issuer?: string; keys?: TestProviderKeys } = {},
): Promise<TestProvider> {
  const issuer = options.issuer ?? "https://idp.test";
  const clientId = "test-client";
  const clientSecret = "test-secret";
  const redirectUri = "http://localhost:4000/auth/callback";
  // Named to avoid shadowing the `keys` getter below: an object literal's
  // method named `keys` would otherwise resolve `keys` to itself.
  let currentKeys = options.keys ?? (await generateRsaKeys());
  const codes = new Map<string, IssuedCode>();
  let tokenCalls = 0;
  let issuedTokenOverride: string | null = null;

  const json = (body: unknown) => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(body);
    },
  });

  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    get keys() {
      return currentKeys;
    },
    rotateKeys(next) {
      currentKeys = next;
    },
    setIssuedToken(token) {
      issuedTokenOverride = token;
    },
    issueCode(input) {
      const code = `code-${randomUUID()}`;
      const now = Math.floor(Date.now() / 1000);
      codes.set(code, {
        codeChallenge: input.codeChallenge,
        nonce: input.nonce,
        claims: {
          iss: issuer,
          aud: clientId,
          sub: input.subject ?? "subject-1",
          name: input.name ?? "Ada Lovelace",
          email: input.email === undefined ? "ada@example.test" : input.email,
          iat: now,
          exp: now + currentKeys.ttlSeconds,
          ...input.claims,
        },
      });
      return code;
    },
    tokenRequests() {
      return tokenCalls;
    },
    async fetch(url, init) {
      if (url.endsWith("/.well-known/openid-configuration")) {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          end_session_endpoint: `${issuer}/logout`,
          id_token_signing_alg_values_supported: ["RS256", "ES256"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.endsWith("/jwks")) {
        return json({ keys: [currentKeys.jwk] });
      }
      if (url.endsWith("/token")) {
        tokenCalls += 1;
        const params = new URLSearchParams(init?.body ?? "");
        const code = params.get("code") ?? "";
        const issued = codes.get(code);
        if (!issued) {
          return {
            ok: false,
            status: 400,
            async text() {
              return JSON.stringify({ error: "invalid_grant" });
            },
          };
        }
        if (
          params.get("client_id") !== clientId ||
          params.get("client_secret") !== clientSecret
        ) {
          return {
            ok: false,
            status: 401,
            async text() {
              return JSON.stringify({ error: "invalid_client" });
            },
          };
        }
        const verifier = params.get("code_verifier") ?? "";
        const challenge = base64url(
          createHash("sha256").update(verifier, "ascii").digest(),
        );
        if (challenge !== issued.codeChallenge) {
          return {
            ok: false,
            status: 400,
            async text() {
              return JSON.stringify({
                error: "invalid_grant",
                error_description: "PKCE",
              });
            },
          };
        }
        codes.delete(code);
        // A provider copies the nonce from the authorization request into the ID
        // token; the client then checks that it matches the one it generated.
        const idToken =
          issuedTokenOverride ??
          (await signIdToken(
            { ...issued.claims, nonce: issued.nonce },
            currentKeys,
          ));
        return json({
          access_token: "access-token-value",
          token_type: "Bearer",
          expires_in: currentKeys.ttlSeconds,
          id_token: idToken,
        });
      }
      if (url.endsWith("/logout")) {
        return json({ ok: true });
      }
      return {
        ok: false,
        status: 404,
        async text() {
          return "not found";
        },
      };
    },
  };
}

/** A signing key that verifies against nothing the provider serves. */
export async function createUnrelatedKeys(): Promise<TestProviderKeys> {
  return generateRsaKeys();
}

/** Exported so a test can assert the PKCE challenge the client built. */
export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}
