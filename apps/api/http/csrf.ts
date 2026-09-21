/**
 * Cross-site request forgery defence for the browser API (Phase 4, item 19).
 *
 * ## The threat model
 *
 * The session credential is an HttpOnly cookie. The browser attaches it to every
 * request to this origin, including requests another site caused. So the question
 * is not "does the request carry a credential" (it does) but "did this
 * application's own page cause it".
 *
 * Two properties already make the common attack impossible, and neither is
 * sufficient on its own:
 *
 * - **`SameSite=Lax`.** A cross-site `POST` (a form, `fetch`, or an `<img>`-less
 *   XHR) does not carry the cookie at all, so a forged mutation arrives anonymous
 *   and fails the session check. Lax is deliberate: `Strict` would break the
 *   top-level redirect back from the identity provider, which *is* a cross-site
 *   navigation that must carry the login-state cookie.
 * - **JSON request bodies.** A cross-site HTML form can only send
 *   `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`,
 *   and this API refuses anything that is not a JSON object. A "simple request"
 *   that skips the CORS preflight therefore cannot hit a JSON endpoint.
 *
 * Those are two independent reasons a forged mutation fails, but both are
 * *ambient*: they depend on cookie policy and content types rather than on an
 * explicit check, and a future endpoint that reads a form body or a future
 * cookie-policy change would quietly remove them. This module adds the explicit
 * check the mission asks for, at the transport where a browser request actually
 * arrives.
 *
 * ## The mechanism
 *
 * It is a **Fetch Metadata / Origin check**, not a synchronizer token:
 *
 * - A state-changing request that carries `Sec-Fetch-Site` must say
 *   `same-origin` (the app's own script) or `none` (a user-initiated
 *   navigation). `same-site` is refused too — a sibling subdomain is a different
 *   security principal.
 * - Otherwise, a request that carries `Origin` must name this server's origin
 *   exactly.
 * - A request with neither header is not a browser-initiated cross-site request:
 *   a server-side client (curl, an agent, the E2E harness) has no ambient cookie
 *   to be tricked into sending. It is allowed, which is also what keeps the API
 *   usable from the command line and from MCP.
 *
 * A synchronizer token was considered and rejected for this phase: it requires
 * server-side token state (or a second signed cookie), a way to inject the token
 * into the SPA, and a story for the OIDC redirect — all to defend a surface that
 * the two properties above already close. The explicit check is the cheap,
 * observable half of the same defence, and it composes with a token later if a
 * deployment ever needs one.
 *
 * ## What this deliberately does not change
 *
 * Authentication semantics are untouched: no new cookie, no new header the
 * browser must remember to send, no change to `/auth/login` and `/auth/callback`
 * (which are `GET` navigations). A refusal is a `403 forbidden` produced by the
 * transport, before any route sees the request.
 *
 * One accepted exception is worth naming. `GET /auth/logout` revokes the session
 * and is reachable by a top-level navigation, which `SameSite=Lax` *does* carry
 * the cookie for — so another site can force a sign-out. That is a nuisance, not
 * a compromise: the attacker gains no access, and the user's next action is to
 * sign in again. Every route that reads or changes documentation is a
 * state-changing method and is covered; the logout link stays a link because the
 * RP-initiated logout redirect has to be a navigation.
 */

/** The methods that must not change state, and so need no check. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The `Sec-Fetch-Site` values a state-changing request may carry. */
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

/** A request reduced to the fields this check reads. */
export interface CrossSiteCheckInput {
  method: string;
  headers: Readonly<Record<string, string>>;
}

/** Why a state-changing request was refused. */
export interface CrossSiteRefusal {
  /** The `sec-fetch-site` value, when the browser sent one. */
  fetchSite?: string;
  /** The `origin` value, when the browser sent one. */
  origin?: string;
}

/**
 * Decide whether a state-changing request came from this application.
 *
 * @param request - The request's method and (lower-cased) headers.
 * @param expectedOrigin - This deployment's public origin, e.g.
 *   `https://diagrams.example.com`. Compared exactly; a path or trailing slash is
 *   ignored, because `Origin` never carries one but operator config might.
 * @returns `null` when the request is allowed, or the reason it was refused.
 */
export function refuseCrossSiteRequest(
  request: CrossSiteCheckInput,
  expectedOrigin: string,
): CrossSiteRefusal | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "") {
    return ALLOWED_FETCH_SITES.has(fetchSite.toLowerCase())
      ? null
      : { fetchSite };
  }

  const origin = request.headers.origin;
  if (origin !== undefined && origin !== "") {
    const expected = normalizeOrigin(expectedOrigin);
    return normalizeOrigin(origin) === expected ? null : { origin };
  }

  // No browser metadata at all: a non-browser client. Nothing forced this
  // request, and there is no ambient cookie an attacker could borrow.
  return null;
}

/** Reduce an origin-ish string to `scheme://host[:port]`, lower-cased. */
function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    // Not a URL (a malformed header): compare it verbatim rather than throwing
    // while handling a refusal.
    return value.replace(/\/+$/, "").toLowerCase();
  }
}
