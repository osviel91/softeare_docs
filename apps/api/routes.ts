/**
 * The API's route table (ADR-040).
 *
 * Controllers are small on purpose. Each one does three things and nothing else:
 * turn the request into an {@link ApplicationContext}, call one use case, and
 * shape the answer. No controller computes a business rule, and no controller
 * decides whether the caller may act — that decision is inside the use case, so
 * the MCP adapter cannot bypass it.
 *
 * Phase 2 adds the authentication routes (`/auth/login`, `/auth/callback`,
 * `/auth/logout`) and `/api/me`; this module owns the health and session
 * surface they need.
 */
import { Router } from "./http/router";
import { json, type ServerRequest } from "./http/http";
import { guarded } from "./http/errors";
import { correlationId } from "./http/node-server";
import { requireContext, resolveSession } from "./context";
import type { AppDependencies } from "./app";

/** The routes this API currently exposes. */
export function createRouter(dependencies: AppDependencies): Router {
  const router = new Router();
  const { config } = dependencies;

  router.get("/healthz", async () =>
    json(200, {
      status: "ok",
      environment: config.environment,
      database: (await dependencies.ping()) ? "ok" : "unavailable",
    }),
  );

  /**
   * The current user, or `null`.
   *
   * Anonymous is a normal answer here rather than a 401: the browser asks this
   * on load to decide whether to render a sign-in button, and treating "nobody"
   * as an error would make every page load log a failure.
   */
  router.get("/api/me", async (request: ServerRequest) =>
    guarded(correlationId(request), async () => {
      const lookup = await resolveSession(dependencies.sessions, request);
      if (lookup.state !== "valid") return json(200, { user: null });
      const context = await requireContext(dependencies.sessions, request);
      return json(200, {
        user: {
          id: context.principal.userId,
          displayName: context.principal.displayName ?? "",
          email: context.principal.email ?? null,
          authType: context.principal.authType,
          scopes: [...context.principal.scopes],
        },
      });
    }),
  );

  return router;
}
