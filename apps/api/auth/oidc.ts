/**
 * The OIDC client: authorization code + PKCE, and ID-token verification
 * (ADR-041).
 *
 * This application does not authenticate anybody. It redirects a browser to an
 * identity provider, receives an authorization code, exchanges it for tokens,
 * and then *verifies* what the provider asserted. It never sees a password,
 * never stores one, and never mints its own identity.
 *
 * Two properties the implementation is built around:
 *
 * - **The verifier is closed.** Signature, issuer, audience, expiry and nonce
 *   are each checked, and a token that fails any of them is refused. There is no
 *   "trusted because it parsed" path.
 * - **Nothing is cached across a login.** Discovery and JWKS documents are cached
 *   with a TTL, but the login transaction (state, nonce, code verifier) travels
 *   in a short-lived signed cookie and is verified for that browser only.
 *
 * Cryptographic verification uses the platform's Web Crypto API (`node:crypto`'s
 * `webcrypto`), never a hand-written signature algorithm: the application does
 * not implement cryptography. The JWS parsing and claim validation around it is
 * this module's own code, a deliberate deviation from the mission's "use a
 * maintained library", recorded in `docs/plan/server-migration-0-3.md`.
 */
import { createHash, randomBytes } from "node:crypto";
import { constantTimeEquals } from "./secret-compare";

/** A fetched HTTP response, reduced to what this module needs. */
export interface HttpFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** The fetch function this module uses. Injectable so a test needs no network. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpFetchResponse>;

/** The settings one identity provider needs. */
export interface OidcClientOptions {
  /** The issuer, exactly as it appears in the `iss` claim. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Scopes to request. `openid` is always included. */
  scopes?: readonly string[];
  /** Where to fetch from. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** How long a discovery or JWKS document may be reused, in ms. */
  cacheTtlMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/** The subset of an OIDC discovery document that is used. */
export interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  userinfo_endpoint?: string;
  id_token_signing_alg_values_supported?: readonly string[];
  code_challenge_methods_supported?: readonly string[];
}

/** The verified identity of a logged-in person. */
export interface VerifiedIdentity {
  /** The `iss` claim. */
  issuer: string;
  /** The `sub` claim. Stable and opaque; the identity key. */
  subject: string;
  displayName: string;
  email: string | null;
}

/** A failure while talking to, or verifying, the identity provider. */
export class OidcError extends Error {
  readonly kind:
    "discovery" | "token_request" | "invalid_token" | "unsupported" | "state";

  constructor(kind: OidcError["kind"], message: string) {
    super(message);
    this.name = "OidcError";
    this.kind = kind;
  }
}

/** What the login route stores for the duration of one login attempt. */
export interface LoginTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Where to send the browser after a successful login. */
  returnTo: string;
}

/**
 * Copy bytes into a fresh, plainly-backed buffer for Web Crypto.
 *
 * `crypto.subtle` requires an `ArrayBuffer`-backed view, and a `Buffer` from
 * `node:crypto` is typed as possibly backed by a `SharedArrayBuffer`. Copying is
 * the honest fix: it is one small allocation per verification, and it keeps the
 * signature check using the platform's implementation rather than a hand-rolled
 * comparison.
 */
function bufferSource(bytes: Uint8Array | Buffer): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

/** Base64url without padding, as JOSE requires. */
function base64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A fresh random value, base64url encoded. */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** A PKCE code verifier: 43–128 characters of unreserved ASCII. */
export function createCodeVerifier(): string {
  return randomToken(32);
}

/** The S256 challenge for a verifier. */
export function codeChallengeS256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** The decoded parts of a compact JWS. */
interface DecodedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
  alg: string;
  kid: string | null;
}

/** Split and decode a compact JWS without verifying it. */
export function decodeJws(token: string): DecodedJws {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new OidcError("invalid_token", "A token must have three parts.");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(
      Buffer.from(encodedHeader, "base64url").toString("utf8"),
    );
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
  } catch {
    throw new OidcError("invalid_token", "A token part is not valid JSON.");
  }
  if (
    typeof header !== "object" ||
    header === null ||
    typeof payload !== "object" ||
    payload === null
  ) {
    throw new OidcError("invalid_token", "A token part is not a JSON object.");
  }
  const record = header as Record<string, unknown>;
  const alg = typeof record.alg === "string" ? record.alg : "";
  const kid = typeof record.kid === "string" ? record.kid : null;
  return {
    header: record,
    payload: payload as Record<string, unknown>,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: Buffer.from(encodedSignature, "base64url"),
    alg,
    kid,
  };
}

/**
 * The algorithms this server accepts for an ID token.
 *
 * An allow-list, not a pass-through: `none` and the HMAC family are refused
 * outright, which closes the classic confusion attack where a token signed with
 * the (public) client secret as an HMAC key is accepted as an RSA token.
 */
const SUPPORTED_ID_TOKEN_ALGORITHMS: Readonly<
  Record<string, { name: string; hash: string }>
> = {
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  RS384: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
  RS512: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
  PS256: { name: "RSA-PSS", hash: "SHA-256" },
  ES256: { name: "ECDSA", hash: "SHA-256" },
  ES384: { name: "ECDSA", hash: "SHA-384" },
  ES512: { name: "ECDSA", hash: "SHA-512" },
};

/** One JSON Web Key, as a JWKS document holds it. */
interface Jwk {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  use?: string;
  alg?: string;
}

/** Import a JWK as a verification key for a supported algorithm. */
async function importKey(
  jwk: Jwk,
  algorithm: { name: string; hash: string },
): Promise<CryptoKey> {
  const key = jwk as JsonWebKey;
  if (algorithm.name === "ECDSA") {
    return crypto.subtle.importKey(
      "jwk",
      key,
      { name: "ECDSA", namedCurve: jwk.crv ?? "P-256" },
      false,
      ["verify"],
    );
  }
  if (algorithm.name === "RSA-PSS") {
    return crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSA-PSS", hash: algorithm.hash },
      false,
      ["verify"],
    );
  }
  return crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: algorithm.hash },
    false,
    ["verify"],
  );
}

/** Import a JWK as an HMAC verification key, for the test provider only. */
async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bufferSource(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/**
 * Verify a compact JWS against a set of keys.
 *
 * @param token - The compact token.
 * @param keys - Candidate keys, tried in order; `kid` narrows them first.
 * @param allowedAlgorithms - The algorithms that may be used to verify.
 * @param hmacSecret - When set, an `HS256` token may be verified against it.
 *   Supplied only by the local test provider; a real deployment leaves it unset,
 *   which is what keeps HMAC out of the accepted set.
 */
export async function verifySignature(
  token: string,
  keys: readonly Jwk[],
  allowedAlgorithms: readonly string[],
  hmacSecret?: string,
): Promise<Record<string, unknown>> {
  const decoded = decodeJws(token);
  if (!allowedAlgorithms.includes(decoded.alg)) {
    throw new OidcError(
      "invalid_token",
      `The token uses ${decoded.alg || "an unknown algorithm"}, which this server does not accept.`,
    );
  }

  // A token that names a key must be verified with *that* key. Falling back to
  // every published key when the `kid` is unknown would accept a token whose
  // signing key the provider has retired — the case key rotation exists for.
  const usable =
    decoded.kid === null ? keys : keys.filter((key) => key.kid === decoded.kid);
  if (usable.length === 0) {
    throw new OidcError(
      "invalid_token",
      "The token names a signing key this provider does not publish.",
    );
  }
  const data = new TextEncoder().encode(decoded.signingInput);

  if (decoded.alg === "HS256") {
    if (hmacSecret === undefined) {
      throw new OidcError(
        "invalid_token",
        "HMAC-signed tokens are not accepted.",
      );
    }
    const key = await importHmacKey(hmacSecret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      bufferSource(decoded.signature),
      bufferSource(data),
    );
    if (!ok)
      throw new OidcError("invalid_token", "The token signature is invalid.");
    return decoded.payload;
  }

  const algorithm = SUPPORTED_ID_TOKEN_ALGORITHMS[decoded.alg];
  if (algorithm === undefined) {
    throw new OidcError(
      "unsupported",
      `Unsupported signing algorithm ${decoded.alg}.`,
    );
  }

  for (const jwk of usable) {
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (jwk.alg !== undefined && jwk.alg !== decoded.alg) continue;
    if (jwk.kty === undefined) continue;
    let key: CryptoKey;
    try {
      key = await importKey(jwk, algorithm);
    } catch {
      // A key of the wrong type is simply not a candidate.
      continue;
    }
    const parameters =
      algorithm.name === "ECDSA"
        ? { name: "ECDSA", hash: algorithm.hash }
        : algorithm.name === "RSA-PSS"
          ? { name: "RSA-PSS", saltLength: 32 }
          : { name: "RSASSA-PKCS1-v1_5" };
    const ok = await crypto.subtle.verify(
      parameters,
      key,
      bufferSource(decoded.signature),
      bufferSource(data),
    );
    if (ok) return decoded.payload;
  }
  throw new OidcError("invalid_token", "The token signature is invalid.");
}

/** A cached document with an expiry. */
interface Cached<T> {
  value: T;
  expiresAt: number;
}

/** The claims an ID token must carry, and what was expected of them. */
export interface IdTokenExpectations {
  issuer: string;
  audience: string;
  nonce: string;
  /** How much clock skew to tolerate, in seconds. */
  clockToleranceSeconds?: number;
}

/**
 * Check the claims of a verified ID token.
 *
 * Every check is a refusal: a token is accepted only when issuer, audience,
 * expiry and nonce all agree with what this login asked for. `email` is read for
 * display and never used as an identity key.
 */
export function verifyIdTokenClaims(
  payload: Record<string, unknown>,
  expectations: IdTokenExpectations,
  nowMs = Date.now(),
): VerifiedIdentity {
  const issuer = payload.iss;
  if (typeof issuer !== "string" || issuer !== expectations.issuer) {
    throw new OidcError(
      "invalid_token",
      `The token was issued by ${String(issuer)}, not ${expectations.issuer}.`,
    );
  }

  const audience = payload.aud;
  const audiences = Array.isArray(audience)
    ? audience.filter((entry): entry is string => typeof entry === "string")
    : typeof audience === "string"
      ? [audience]
      : [];
  if (!audiences.includes(expectations.audience)) {
    throw new OidcError(
      "invalid_token",
      "The token was not issued for this application.",
    );
  }

  const tolerance = (expectations.clockToleranceSeconds ?? 60) * 1000;
  const now = nowMs;
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new OidcError("invalid_token", "The token has no expiry.");
  }
  if (payload.exp * 1000 + tolerance < now) {
    throw new OidcError("invalid_token", "The token has expired.");
  }
  if (typeof payload.nbf === "number" && payload.nbf * 1000 - tolerance > now) {
    throw new OidcError("invalid_token", "The token is not valid yet.");
  }
  if (typeof payload.iat === "number" && payload.iat * 1000 - tolerance > now) {
    throw new OidcError("invalid_token", "The token was issued in the future.");
  }
  const nonce = payload.nonce;
  if (
    typeof nonce !== "string" ||
    !constantTimeEquals(nonce, expectations.nonce)
  ) {
    throw new OidcError(
      "invalid_token",
      "The token's nonce does not match this login attempt.",
    );
  }

  const subject = payload.sub;
  if (typeof subject !== "string" || subject === "") {
    throw new OidcError("invalid_token", "The token has no subject.");
  }

  const name =
    typeof payload.name === "string" && payload.name !== ""
      ? payload.name
      : typeof payload.preferred_username === "string" &&
          payload.preferred_username !== ""
        ? payload.preferred_username
        : subject;
  const email =
    typeof payload.email === "string" && payload.email !== ""
      ? payload.email
      : null;

  return { issuer, subject, displayName: name, email };
}

/** The client. */
export interface OidcClient {
  /** The provider's discovery document, cached. */
  metadata(): Promise<ProviderMetadata>;
  /** Build the authorization URL for a login transaction. */
  authorizationUrl(transaction: LoginTransaction): Promise<string>;
  /**
   * Exchange an authorization code and return the verified identity.
   *
   * @throws {OidcError} when the exchange fails or the token does not verify.
   */
  exchange(
    code: string,
    transaction: LoginTransaction,
  ): Promise<VerifiedIdentity>;
  /** The provider's end-session URL, when it advertises one. */
  endSessionUrl(input: {
    idTokenHint?: string;
    postLogoutRedirectUri: string;
    state?: string;
  }): Promise<string | null>;
}

/** The default fetch: the platform's, with the shape this module needs. */
const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, init as RequestInit);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
};

/** Build the OIDC client for one provider. */
export function createOidcClient(options: OidcClientOptions): OidcClient {
  const fetchImpl = options.fetch ?? defaultFetch;
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  const scopes = options.scopes ?? ["openid", "profile", "email"];

  let metadataCache: Cached<ProviderMetadata> | null = null;
  let jwksCache: Cached<Jwk[]> | null = null;

  const discoveryUrl = `${options.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;

  const metadata = async (): Promise<ProviderMetadata> => {
    if (metadataCache && metadataCache.expiresAt > now())
      return metadataCache.value;
    const response = await fetchImpl(discoveryUrl, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new OidcError(
        "discovery",
        `The identity provider's discovery document could not be read (HTTP ${response.status}).`,
      );
    }
    const document = parseJson(await response.text(), "discovery");
    const documentIssuer = document.issuer;
    if (typeof documentIssuer !== "string") {
      throw new OidcError("discovery", "The discovery document has no issuer.");
    }
    if (
      documentIssuer.replace(/\/+$/, "") !== options.issuer.replace(/\/+$/, "")
    ) {
      throw new OidcError(
        "discovery",
        `The discovery document claims issuer ${documentIssuer}, not ${options.issuer}.`,
      );
    }
    const endpoints = {
      issuer: documentIssuer,
      authorization_endpoint: requireString(document, "authorization_endpoint"),
      token_endpoint: requireString(document, "token_endpoint"),
      jwks_uri: requireString(document, "jwks_uri"),
    };
    const parsed: ProviderMetadata = {
      ...endpoints,
      ...(typeof document.end_session_endpoint === "string"
        ? { end_session_endpoint: document.end_session_endpoint }
        : {}),
      ...(typeof document.userinfo_endpoint === "string"
        ? { userinfo_endpoint: document.userinfo_endpoint }
        : {}),
      ...(Array.isArray(document.id_token_signing_alg_values_supported)
        ? {
            id_token_signing_alg_values_supported:
              document.id_token_signing_alg_values_supported.filter(
                (entry): entry is string => typeof entry === "string",
              ),
          }
        : {}),
      ...(Array.isArray(document.code_challenge_methods_supported)
        ? {
            code_challenge_methods_supported:
              document.code_challenge_methods_supported.filter(
                (entry): entry is string => typeof entry === "string",
              ),
          }
        : {}),
    };
    metadataCache = { value: parsed, expiresAt: now() + cacheTtlMs };
    return parsed;
  };

  const jwks = async (force = false): Promise<Jwk[]> => {
    if (!force && jwksCache && jwksCache.expiresAt > now())
      return jwksCache.value;
    const document = await metadata();
    const response = await fetchImpl(document.jwks_uri, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new OidcError(
        "discovery",
        `The provider's key set could not be read (HTTP ${response.status}).`,
      );
    }
    const parsed = parseJson(await response.text(), "jwks");
    const keys = Array.isArray(parsed.keys) ? (parsed.keys as Jwk[]) : [];
    if (keys.length === 0) {
      throw new OidcError("discovery", "The provider's key set is empty.");
    }
    jwksCache = { value: keys, expiresAt: now() + cacheTtlMs };
    return keys;
  };

  const tokenRequest = async (
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> => {
    const document = await metadata();
    const response = await fetchImpl(document.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(body).toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      // The provider's body may explain the failure, but it is not echoed to a
      // browser: it can carry provider-side detail about the client.
      throw new OidcError(
        "token_request",
        `The identity provider refused the token request (HTTP ${response.status}).`,
      );
    }
    return parseJson(text, "token");
  };

  return {
    metadata,

    async authorizationUrl(transaction) {
      const document = await metadata();
      const methods = document.code_challenge_methods_supported;
      if (methods !== undefined && !methods.includes("S256")) {
        throw new OidcError(
          "unsupported",
          "The identity provider does not support PKCE with S256, which this application requires.",
        );
      }
      const url = new URL(document.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", options.redirectUri);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", transaction.state);
      url.searchParams.set("nonce", transaction.nonce);
      url.searchParams.set(
        "code_challenge",
        codeChallengeS256(transaction.codeVerifier),
      );
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },

    async exchange(code, transaction) {
      const token = await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: options.redirectUri,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code_verifier: transaction.codeVerifier,
      });
      const idToken = token.id_token;
      if (typeof idToken !== "string" || idToken === "") {
        throw new OidcError(
          "invalid_token",
          "The identity provider returned no ID token.",
        );
      }

      let keys = await jwks();
      let payload: Record<string, unknown>;
      try {
        payload = await verifySignature(
          idToken,
          keys,
          Object.keys(SUPPORTED_ID_TOKEN_ALGORITHMS),
        );
      } catch (error) {
        // A key rotation is the one recoverable case: refetch once, then fail.
        if (!(error instanceof OidcError) || error.kind !== "invalid_token")
          throw error;
        keys = await jwks(true);
        payload = await verifySignature(
          idToken,
          keys,
          Object.keys(SUPPORTED_ID_TOKEN_ALGORITHMS),
        );
      }

      return verifyIdTokenClaims(
        payload,
        {
          issuer: options.issuer.replace(/\/+$/, ""),
          audience: options.clientId,
          nonce: transaction.nonce,
        },
        now(),
      );
    },

    async endSessionUrl(input) {
      let document: ProviderMetadata;
      try {
        document = await metadata();
      } catch {
        return null;
      }
      if (document.end_session_endpoint === undefined) return null;
      const url = new URL(document.end_session_endpoint);
      if (input.idTokenHint !== undefined) {
        url.searchParams.set("id_token_hint", input.idTokenHint);
      }
      url.searchParams.set(
        "post_logout_redirect_uri",
        input.postLogoutRedirectUri,
      );
      if (input.state !== undefined) url.searchParams.set("state", input.state);
      return url.toString();
    },
  };
}

/** Parse a JSON document, refusing one that is not an object. */
function parseJson(text: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OidcError(
      "invalid_token",
      `The provider's ${what} response is not JSON.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OidcError(
      "invalid_token",
      `The provider's ${what} response is not an object.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** Read a required string field of a discovery document. */
function requireString(
  document: Record<string, unknown>,
  name: string,
): string {
  const value = document[name];
  if (typeof value !== "string" || value === "") {
    throw new OidcError("discovery", `The discovery document has no ${name}.`);
  }
  return value;
}
