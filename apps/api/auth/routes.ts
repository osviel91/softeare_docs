/**
 * The authentication routes (ADR-041).
 *
 * Four routes, and the shape of each is deliberate:
 *
 * - `GET /auth/login` starts a login: generate state, nonce and a PKCE verifier,
 *   put them in a signed short-lived cookie, redirect to the provider.
 * - `GET /auth/callback` verifies the state, exchanges the code, verifies the ID
 *   token, maps `(issuer, subject)` onto an internal user, creates a session row
 *   and sets the session cookie. It never trusts the query string beyond `code`
 *   and `state`.
 * - `POST /auth/logout` revokes the session server-side, clears the cookie, and
 *   optionally sends the browser to the provider's end-session endpoint.
 * - `GET /api/me` answers who is signed in, and is happy to answer "nobody".
 *
 * Two behaviours worth naming because they are security decisions rather than
 * conveniences:
 *
 * - **The provider's error is not echoed.** A failed exchange logs a correlation
 *   id and redirects with a short code; it never renders provider detail into
 *   the page.
 * - **The raw ID token is not kept.** It is verified and discarded; the session
 *   is ours, and the browser holds only our own session cookie.
 */
import {
  cookie,
  clearCookie,
  errorResponse,
  json,
  parseJsonBody,
  redirect,
} from "../http/http";
import type { ServerRequest, ServerResponse } from "../http/http";
import { guarded } from "../http/errors";
import { correlationId } from "../http/node-server";
import type { AppDependencies } from "../app";
import {
  SESSION_COOKIE,
  createSessionToken,
  hashSessionToken,
  sessionIdOf,
} from "../context";
import {
  LOGIN_COOKIE,
  decodeLoginState,
  encodeLoginState,
  safeReturnTo,
} from "./login-state";
import {
  createCodeVerifier,
  createOidcClient,
  randomToken,
  type OidcClient,
} from "./oidc";
import { OidcError } from "./oidc";
import { hashPassword, verifyPassword } from "./password";

/** The routes the authentication surface exposes. */
export interface AuthRoutes {
  login(request: ServerRequest): Promise<ServerResponse>;
  callback(request: ServerRequest): Promise<ServerResponse>;
  register(request: ServerRequest): Promise<ServerResponse>;
  localLogin(request: ServerRequest): Promise<ServerResponse>;
  logout(request: ServerRequest): Promise<ServerResponse>;
  endSession(request: ServerRequest): Promise<ServerResponse>;
}

/** Build the OIDC client from a validated configuration, or `null`. */
export function oidcClientFor(
  dependencies: AppDependencies,
): OidcClient | null {
  const oidc = dependencies.config.oidc;
  if (oidc === null) return null;
  const settings = {
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    clientSecret: oidc.clientSecret,
    redirectUri: oidc.redirectUri,
  };
  return createOidcClient(
    dependencies.config.oidcFetch === undefined
      ? settings
      : { ...settings, fetch: dependencies.config.oidcFetch },
  );
}

/** Reduce a request's user agent to something loggable and bounded. */
function userAgentOf(request: ServerRequest): string | null {
  const value = request.headers["user-agent"];
  if (value === undefined) return null;
  return value.slice(0, 300);
}

/** Build the authentication routes over the application's dependencies. */
export function createAuthRoutes(
  dependencies: AppDependencies,
  client: OidcClient | null = oidcClientFor(dependencies),
): AuthRoutes {
  const { config, sessions, users } = dependencies;

  /** Clear the login-state cookie on every completion path. */
  const clearLogin = () => clearCookie(LOGIN_COOKIE, { path: "/" });

  /** A login failure that tells the browser nothing beyond "try again". */
  const failedLogin = (requestId: string, reason: string): ServerResponse => {
    process.stderr.write(`${requestId} login failed: ${reason}\n`);
    return redirect("/?auth=failed", 303);
  };

  const createSessionCookie = async (
    request: ServerRequest,
    userId: string,
  ) => {
    const sessionId = crypto.randomUUID();
    const token = createSessionToken(sessionId);
    await sessions.create({
      id: sessionId,
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + config.sessionTtlSeconds * 1000),
      userAgent: userAgentOf(request),
    });
    return cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "Lax",
      maxAgeSeconds: config.sessionTtlSeconds,
    });
  };

  return {
    async login(request) {
      return guarded(correlationId(request), async () => {
        if (client === null) {
          return errorResponse(
            503,
            "unavailable",
            "Sign-in is not configured on this server.",
          );
        }
        const transaction = {
          state: randomToken(24),
          nonce: randomToken(24),
          codeVerifier: createCodeVerifier(),
          returnTo: safeReturnTo(request.query.returnTo),
        };
        const authorizationUrl = await client.authorizationUrl(transaction);
        const response = redirect(authorizationUrl, 302);
        return {
          ...response,
          headers: [
            ...response.headers,
            cookie(
              LOGIN_COOKIE,
              encodeLoginState(config.cookieSecret, transaction),
              {
                httpOnly: true,
                secure: config.secureCookies,
                sameSite: "Lax",
                maxAgeSeconds: 600,
              },
            ),
          ],
        };
      });
    },

    async callback(request) {
      return guarded(correlationId(request), async () => {
        const requestId = correlationId(request);
        if (client === null) {
          return errorResponse(
            503,
            "unavailable",
            "Sign-in is not configured on this server.",
          );
        }

        const transaction = decodeLoginState(
          config.cookieSecret,
          request.cookies[LOGIN_COOKIE],
        );
        if (transaction === null) {
          const response = failedLogin(requestId, "no usable login state");
          return { ...response, headers: [...response.headers, clearLogin()] };
        }

        // The state in the query must match the state this browser was given.
        const suppliedState = request.query.state ?? "";
        if (suppliedState === "" || suppliedState !== transaction.state) {
          const response = failedLogin(requestId, "state mismatch");
          return { ...response, headers: [...response.headers, clearLogin()] };
        }

        const code = request.query.code;
        if (code === undefined || code === "") {
          // The provider reported a failure (or the user declined).
          const response = failedLogin(
            requestId,
            `no authorization code (${request.query.error ?? "unknown"})`,
          );
          return { ...response, headers: [...response.headers, clearLogin()] };
        }

        let identity;
        try {
          identity = await client.exchange(code, transaction);
        } catch (error) {
          const reason =
            error instanceof OidcError
              ? `${error.kind}: ${error.message}`
              : "unexpected error";
          const response = failedLogin(requestId, reason);
          return { ...response, headers: [...response.headers, clearLogin()] };
        }

        const user = await users.findOrCreateByExternalIdentity(identity);
        if (
          config.platformAdminEmail !== null &&
          user.email?.toLowerCase() === config.platformAdminEmail &&
          (!user.platformAdmin || user.status !== "ACTIVE")
        ) {
          await dependencies.sql.query(
            "UPDATE users SET platform_admin = true, status = 'ACTIVE', updated_at = now() WHERE id = $1",
            [user.id],
          );
        } else if (
          config.platformAdminEmail !== null &&
          user.status === "ACTIVE"
        ) {
          await dependencies.sql.query(
            "UPDATE users SET status = 'PENDING', updated_at = now() WHERE id = $1",
            [user.id],
          );
        }
        const sessionCookie = await createSessionCookie(request, user.id);
        const response = redirect(safeReturnTo(transaction.returnTo), 303);
        return {
          ...response,
          headers: [...response.headers, sessionCookie, clearLogin()],
        };
      });
    },

    async register(request) {
      return guarded(correlationId(request), async () => {
        const body = parseJsonBody(request.body);
        const email = normalizedEmail(body.email);
        const password = typeof body.password === "string" ? body.password : "";
        if (!isEmail(email)) {
          return errorResponse(422, "invalid", "Enter a valid email address.");
        }
        if (password.length < 12) {
          return errorResponse(
            422,
            "invalid",
            "Password must be at least 12 characters.",
          );
        }
        const existing = await users.findLocalByEmail(email);
        if (existing) {
          return errorResponse(
            409,
            "conflict",
            "An account with that email already exists.",
          );
        }
        const displayName =
          typeof body.displayName === "string" && body.displayName.trim() !== ""
            ? body.displayName.trim().slice(0, 120)
            : email.split("@", 1)[0];
        const passwordData = await hashPassword(password);
        try {
          await users.createLocalAccount({
            email,
            displayName,
            passwordSalt: passwordData.salt,
            passwordHash: passwordData.hash,
          });
        } catch {
          return errorResponse(
            409,
            "conflict",
            "An account with that email already exists.",
          );
        }
        return json(202, {
          status: "PENDING",
          message: "Your account is awaiting administrator approval.",
        });
      });
    },

    async localLogin(request) {
      return guarded(correlationId(request), async () => {
        const body = parseJsonBody(request.body);
        const email = normalizedEmail(body.email);
        const password = typeof body.password === "string" ? body.password : "";
        const record = isEmail(email)
          ? await users.findLocalByEmail(email)
          : null;
        const valid = record
          ? await verifyPassword(
              password,
              record.passwordSalt,
              record.passwordHash,
            )
          : false;
        if (!record || !valid) {
          return errorResponse(
            401,
            "unauthorized",
            "Invalid email or password.",
          );
        }
        if (record.user.status !== "ACTIVE" && !record.user.platformAdmin) {
          return errorResponse(
            403,
            "forbidden",
            record.user.status === "PENDING"
              ? "Your account is awaiting administrator approval."
              : "This account cannot sign in.",
          );
        }
        const sessionCookie = await createSessionCookie(
          request,
          record.user.id,
        );
        return json(200, { status: "authenticated" }, [sessionCookie]);
      });
    },

    async logout(request) {
      return guarded(correlationId(request), async () => {
        // The session is identified by the cookie, never by a body or a query
        // parameter: a caller-supplied identifier would make "log someone else
        // out" a denial-of-service primitive. Revoking is idempotent, and a
        // cookie that names no session is simply cleared.
        const raw = request.cookies[SESSION_COOKIE] ?? "";
        const id = sessionIdOf(raw);
        if (id !== null) await sessions.revoke(id).catch(() => {});
        return json(204, null, [clearCookie(SESSION_COOKIE)]);
      });
    },

    /**
     * Send the browser to the provider's end-session endpoint, if it has one.
     *
     * Logout has already happened server-side by the time this runs; this only
     * ends the provider's own session, which is what a user expects when they
     * sign out of a shared machine.
     */
    async endSession(request) {
      return guarded(correlationId(request), async () => {
        const registry = dependencies.config.oidc;
        if (client === null || registry === null) return redirect("/", 302);
        const url = await client.endSessionUrl({
          postLogoutRedirectUri: registry.postLogoutRedirectUri,
        });
        return redirect(url ?? "/", 302);
      });
    },
  };
}

function normalizedEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
