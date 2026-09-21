/**
 * The login-state cookie (ADR-041).
 *
 * Between "redirect the browser to the identity provider" and "the provider
 * redirected back", this server must remember three secrets it generated:
 * `state` (which binds the callback to the browser that started it), `nonce`
 * (which binds the ID token to this attempt) and the PKCE code verifier.
 *
 * They ride in a short-lived cookie rather than a server-side row, because a
 * login that never completes should leave nothing behind. The cookie is
 * **signed, not encrypted**: its contents are not secret from the browser, but
 * they cannot be *altered* without the server key, which is what stops an
 * attacker from substituting their own verifier or nonce.
 *
 * It is `HttpOnly` and short-lived, and it is cleared on every completion path —
 * success, failure or a callback that arrives with junk in it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { LoginTransaction } from "./oidc";

/** The cookie a login transaction rides in. */
export const LOGIN_COOKIE = "sdm_login";

/** How long a login attempt may take before its state is refused. */
export const LOGIN_TTL_SECONDS = 600;

/** The value inside the cookie, before signing. */
interface LoginState extends LoginTransaction {
  /** Expiry, as epoch seconds. */
  exp: number;
}

/** Sign a payload with the server's cookie secret. */
function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("base64url");
}

/** Serialise and sign a login transaction. */
export function encodeLoginState(
  secret: string,
  transaction: LoginTransaction,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const state: LoginState = {
    ...transaction,
    exp: nowSeconds + LOGIN_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString(
    "base64url",
  );
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * Verify and decode a login transaction.
 *
 * Returns `null` for every failure — a bad signature, a malformed payload, an
 * expired attempt — because the caller's response is the same in each case:
 * refuse the callback and start a new login. Distinguishing them would only
 * help an attacker.
 */
export function decodeLoginState(
  secret: string,
  value: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): LoginTransaction | null {
  if (value === undefined || value === "") return null;
  const index = value.lastIndexOf(".");
  if (index <= 0) return null;
  const payload = value.slice(0, index);
  const provided = value.slice(index + 1);
  const expected = sign(secret, payload);
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (providedBytes.length !== expectedBytes.length) return null;
  if (!timingSafeEqual(providedBytes, expectedBytes)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const state = parsed as Partial<LoginState>;
  if (
    typeof state.state !== "string" ||
    typeof state.nonce !== "string" ||
    typeof state.codeVerifier !== "string" ||
    typeof state.returnTo !== "string" ||
    typeof state.exp !== "number"
  ) {
    return null;
  }
  if (state.exp < nowSeconds) return null;
  return {
    state: state.state,
    nonce: state.nonce,
    codeVerifier: state.codeVerifier,
    returnTo: state.returnTo,
  };
}

/**
 * Restrict a post-login destination to this application.
 *
 * An open redirect is a phishing primitive: `?returnTo=https://evil.example`
 * would let an attacker use our domain to land a user somewhere else. Only a
 * root-relative path is accepted; anything else falls back to the site root.
 */
export function safeReturnTo(candidate: string | undefined): string {
  if (candidate === undefined || candidate === "") return "/";
  if (!candidate.startsWith("/")) return "/";
  // `//host` and `/\host` are protocol-relative and therefore absolute.
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return "/";
  if (candidate.includes("\\")) return "/";
  return candidate;
}
