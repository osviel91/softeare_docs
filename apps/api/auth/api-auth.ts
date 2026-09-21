/**
 * Convergence of the two authentication mechanisms (ADR-043, Phase 5 §28–29).
 *
 * A request may carry a session cookie, a bearer credential, or (accidentally)
 * both. This module is the one place that decides which one identifies the
 * caller:
 *
 * - **The `Authorization` header wins.** An explicit API credential is a
 *   deliberate act; a cookie is ambient and may merely be present because the
 *   same browser is signed in.
 * - **Authorities are never merged.** When a bearer credential is present the
 *   session is not consulted at all, so a request can never be authorized by
 *   the union of two credentials.
 *
 * Browser management endpoints deliberately call the session-only
 * `requireContext` instead: an agent credential must not be able to manage
 * agents or credentials, however it is presented.
 */
import type { ApplicationContext } from "../../../src/application/context";
import type { ServerRequest } from "../http/http";
import { requireContext } from "../context";
import { hasBearerCredential, requireBearerContext } from "./agent-credential";
import type { AppDependencies } from "../app";

/**
 * The authenticated context for a general API request, or a 401-mapped failure.
 *
 * @throws {ApplicationError} `unauthorized` when neither credential is usable.
 */
export async function requireApiContext(
  dependencies: AppDependencies,
  request: ServerRequest,
): Promise<ApplicationContext> {
  if (hasBearerCredential(request)) {
    return requireBearerContext(
      dependencies.credentials,
      request,
      dependencies.tokenPepper,
    );
  }
  return requireContext(dependencies.sessions, request);
}
