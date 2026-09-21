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
 * The JOSE mechanics — compact-JWS parsing, key selection, signature checks and
 * the claims the library can validate — are delegated to the maintained `jose`
 * package (Phase 4C). This module keeps only the decisions that are ours: which
 * issuer, audience and algorithms may be accepted, that a `nonce` belongs to
 * *this* login, and that a subject is present. The installable discovery
 * document and the token/PKCE flows remain this module's own code. The previous
 * hand-rolled verifier this replaced is recorded in
 * `docs/plan/server-migration-0-3.md`.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type FetchImplementation,
  type JWSAlgorithm,
  type JWTVerifyGetKey,
  type RemoteJWKSet,
} from "jose";
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
  /**
   * How long the discovery document may be reused, in ms. The JWKS cache is
   * jose's own and is bounded by its `cacheMaxAge` default instead.
   */
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

/**
 * The algorithms this server accepts for an ID token.
 *
 * An allow-list, not a pass-through: `none` and the HMAC family are absent, so
 * a token can never choose its own algorithm. That closes the classic confusion
 * attack where a token signed with the (public) client secret as an HMAC key is
 * accepted as an RSA token — jose refuses the algorithm before any key is
 * consulted, because the list below is passed to it, not read from the header.
 */
const SUPPORTED_ID_TOKEN_ALGORITHMS: readonly JWSAlgorithm[] = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "ES256",
  "ES384",
  "ES512",
];

/** The clock skew tolerated on `exp`/`nbf`/`iat`, in seconds. */
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;

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
 *
 * `jose` has already verified the signature and validated `iss`, `aud`, `exp`
 * and `nbf` with the same clock tolerance when this runs from `exchange`; the
 * function is kept because the `nonce` and `sub` checks are this module's, and
 * because a caller holding only a payload (a test, say) still gets the full
 * check rather than a partial one.
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

  const tolerance =
    (expectations.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS) *
    1000;
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

/**
 * A human-readable reason for a claim jose refused.
 *
 * The claim name is a fixed vocabulary, so the message can name the actual
 * problem instead of echoing jose's generic "unexpected claim value".
 */
function claimFailureMessage(error: { readonly claim: string }): string {
  switch (error.claim) {
    case "iss":
      return "The token was issued by a different issuer.";
    case "aud":
      return "The token was not issued for this application.";
    case "exp":
      return "The token has expired.";
    case "nbf":
      return "The token is not valid yet.";
    case "iat":
      return "The token was issued in the future.";
    case "sub":
      return "The token has no subject.";
    default:
      return `The token's ${error.claim} claim is invalid.`;
  }
}

/**
 * Translate a jose verification failure into this module's error type.
 *
 * Everything jose rejects because of *the token* becomes `invalid_token`: a
 * failed claim check, a failed signature, a malformed compact JWS, or a header
 * naming an algorithm the allow-list excludes. Failures that belong to the
 * provider — an unreachable or malformed key set — never arrive here, because
 * the key resolver wraps them as `discovery` before jose can surface them.
 *
 * `JWTExpired` gets its own branch because jose models it as a sibling of
 * `JWTClaimValidationFailed`, not as a subclass: checking only the latter would
 * report an expired token with jose's generic claim message.
 */
function invalidTokenError(error: unknown): OidcError {
  if (error instanceof OidcError) return error;
  if (error instanceof errors.JWTExpired) {
    return new OidcError("invalid_token", "The token has expired.");
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    return new OidcError("invalid_token", claimFailureMessage(error));
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return new OidcError("invalid_token", "The token signature is invalid.");
  }
  if (error instanceof errors.JOSEAlgNotAllowed) {
    return new OidcError(
      "invalid_token",
      "The token uses a signing algorithm this server does not accept.",
    );
  }
  if (error instanceof errors.JWKSNoMatchingKey) {
    return new OidcError(
      "invalid_token",
      "The token names a signing key this provider does not publish.",
    );
  }
  if (error instanceof errors.JOSEError) {
    return new OidcError(
      "invalid_token",
      `The token is not a valid ID token (${error.code}).`,
    );
  }
  return new OidcError("invalid_token", "The token could not be verified.");
}

/**
 * Adapt this module's small `FetchLike` seam to jose's `customFetch` contract.
 *
 * jose's remote key set asks for a WHATWG `Response`; this module's injectable
 * fetch deliberately returns only the members its own callers need. `status`
 * and `json()` are the two the JWKS fetch actually reads, so a small shim is the
 * honest bridge: the injectable seam survives and no test needs a network.
 */
function jwksFetch(fetchImpl: FetchLike): FetchImplementation {
  return async (url) => {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
    });
    return {
      ok: response.ok,
      status: response.status,
      async json(): Promise<unknown> {
        return JSON.parse(await response.text());
      },
    } as unknown as Response;
  };
}

/** Build the OIDC client for one provider. */
export function createOidcClient(options: OidcClientOptions): OidcClient {
  const fetchImpl = options.fetch ?? defaultFetch;
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  const scopes = options.scopes ?? ["openid", "profile", "email"];
  // The `iss` this client accepts, normalised the same way discovery is: a
  // provider that publishes a trailing slash must not make its own tokens fail.
  const issuerClaim = options.issuer.replace(/\/+$/, "");

  let metadataCache: Cached<ProviderMetadata> | null = null;
  // jose owns the JWKS cache. The resolver is rebuilt only when a newly fetched
  // discovery document points at a different `jwks_uri`.
  let keySet: RemoteJWKSet | null = null;
  let keySetUrl: string | null = null;

  const discoveryUrl = `${issuerClaim}/.well-known/openid-configuration`;

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
    if (documentIssuer.replace(/\/+$/, "") !== issuerClaim) {
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

  /**
   * The resolver jose verifies against, built on demand from discovery.
   *
   * `cooldownDuration: 0` is deliberate. jose otherwise refuses to refetch a
   * key set for 30 seconds after a successful fetch, so a provider that rotated
   * its signing key would be unusable until the cooldown lapsed — a
   * restart-shaped failure for a routine rotation. `cacheMaxAge` keeps the
   * ordinary case cached; only an unknown `kid` triggers the extra fetch, and
   * jose attempts exactly one per verification.
   */
  const resolveKey: JWTVerifyGetKey = async (protectedHeader, token) => {
    let resolver: RemoteJWKSet;
    try {
      const document = await metadata();
      if (keySet === null || keySetUrl !== document.jwks_uri) {
        keySet = createRemoteJWKSet(new URL(document.jwks_uri), {
          cooldownDuration: 0,
          // The symbol is jose's opt-in for a caller-supplied transport; the
          // same injectable fetch that serves discovery serves the key set.
          [customFetch]: jwksFetch(fetchImpl),
        });
        keySetUrl = document.jwks_uri;
      }
      resolver = keySet;
    } catch (error) {
      // `metadata()` already reports as `discovery`; anything else here is a
      // malformed `jwks_uri`, which is a provider problem too.
      if (error instanceof OidcError) throw error;
      throw new OidcError(
        "discovery",
        "The provider's key set location is invalid.",
      );
    }
    try {
      return await resolver(protectedHeader, token);
    } catch (error) {
      // An unknown `kid` is the token's problem, not the provider's: it must
      // become `invalid_token` (jose has already retried after the rotation).
      if (error instanceof errors.JWKSNoMatchingKey) throw error;
      throw new OidcError(
        "discovery",
        "The provider's key set could not be read.",
      );
    }
  };

  /**
   * Verify a compact ID token with jose, under this server's own policy.
   *
   * The issuer, audience and algorithm list come from configuration and an
   * allow-list — never from the token — and the injectable clock is threaded
   * through `currentDate` so a test's `now` governs expiry exactly as it did
   * before. `requiredClaims` makes a token without `exp` or `sub` a claim
   * failure here rather than a surprise later.
   */
  const verifyIdToken = async (
    idToken: string,
  ): Promise<Record<string, unknown>> => {
    try {
      const { payload } = await jwtVerify(idToken, resolveKey, {
        issuer: issuerClaim,
        audience: options.clientId,
        algorithms: [...SUPPORTED_ID_TOKEN_ALGORITHMS],
        clockTolerance: DEFAULT_CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(now()),
        requiredClaims: ["exp", "sub"],
      });
      return payload as Record<string, unknown>;
    } catch (error) {
      throw invalidTokenError(error);
    }
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

      const payload = await verifyIdToken(idToken);
      // The signature and the claims jose can check are settled; the nonce,
      // subject and display-name derivation are still this module's to enforce.
      return verifyIdTokenClaims(
        payload,
        {
          issuer: issuerClaim,
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
