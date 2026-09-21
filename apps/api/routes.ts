/**
 * The API's route table (ADR-040, ADR-041).
 *
 * Controllers are small on purpose. Each one does three things and nothing else:
 * turn the request into an {@link ApplicationContext}, call one use case, and
 * shape the answer. No controller computes a business rule, and no controller
 * decides whether the caller may act — that decision is inside the use case, so
 * the MCP adapter cannot bypass it.
 *
 * The URL space follows the mission's resource surface: projects are addressed by
 * id, their resources by id, and a path is resource *metadata* rather than an
 * address. That is what makes `userId`/`projectId`/`resourceId` the authority
 * boundary and a filesystem path nothing more than a field.
 */
import { Router } from "./http/router";
import {
  errorResponse,
  json,
  parseJsonBody,
  type ServerRequest,
} from "./http/http";
import { guarded } from "./http/errors";
import { correlationId } from "./http/node-server";
import { requireApiContext } from "./auth/api-auth";
import { hasBearerCredential } from "./auth/agent-credential";
import { resolveSession } from "./context";
import { createAuthRoutes, oidcClientFor } from "./auth/routes";
import { registerAgentRoutes } from "./agents/routes";
import { registerRemoteMcpRoutes } from "./mcp/routes";
import type { ProjectRole } from "../../src/domain/access/permissions";
import { isProjectRole } from "../../src/domain/access/permissions";
import { invalid } from "../../src/application/errors";
import type { AppDependencies } from "./app";

/** The routes this API exposes. */
export function createRouter(dependencies: AppDependencies): Router {
  const router = new Router();
  const { config, catalog } = dependencies;
  const auth = createAuthRoutes(dependencies, oidcClientFor(dependencies));
  const signInConfigured = oidcClientFor(dependencies) !== null;

  /**
   * The authenticated context for a general project/resource request.
   *
   * Either credential works: an explicit `Authorization: Bearer` wins over the
   * ambient session cookie, and the two are never merged. Agent management
   * routes deliberately do not use this — they are session-only.
   */
  const contextOf = (request: ServerRequest) =>
    requireApiContext(dependencies, request);

  router.get("/healthz", async () =>
    json(200, {
      status: "ok",
      environment: config.environment,
      database: (await dependencies.ping()) ? "ok" : "unavailable",
      signIn: signInConfigured ? "oidc" : "unconfigured",
    }),
  );

  // ---- Authentication -------------------------------------------------------

  router.get("/auth/login", (request) => auth.login(request));
  router.get("/auth/callback", (request) => auth.callback(request));
  router.post("/auth/logout", (request) => auth.logout(request));
  router.get("/auth/logout", (request) => auth.endSession(request));

  /**
   * The current user, or `null`.
   *
   * Anonymous is a normal answer here rather than a 401: the browser asks this
   * on load to decide whether to render a sign-in button, and treating "nobody"
   * as an error would make every page load log a failure.
   *
   * A bearer credential *is* answered, because a machine client may reasonably
   * ask who it is; it returns `user: null` and a `principal` describing the
   * agent and the user it acts for. The browser's `user` shape is unchanged.
   */
  router.get("/api/me", async (request) =>
    guarded(correlationId(request), async () => {
      if (hasBearerCredential(request)) {
        const context = await contextOf(request);
        return json(200, { user: null, principal: principalView(context) });
      }
      const lookup = await resolveSession(dependencies.sessions, request);
      if (lookup.state !== "valid") return json(200, { user: null });
      const context = await contextOf(request);
      return json(200, {
        user: {
          id: context.principal.subjectUserId,
          displayName: context.principal.displayName ?? "",
          email: context.principal.email ?? null,
          authType: context.principal.authType,
          scopes: [...context.principal.scopes],
        },
        principal: principalView(context),
      });
    }),
  );

  // ---- Projects -------------------------------------------------------------

  router.get("/api/projects", async (request) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const listings = await catalog.listProjects(context);
      return json(200, {
        projects: listings.map((listing) => projectView(listing)),
      });
    }),
  );

  router.post("/api/projects", async (request) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const body = parseJsonBody(request.body);
      const listing = await catalog.createProject(context, {
        name: requireBodyString(body, "name"),
        ...(typeof body.slug === "string" ? { slug: body.slug } : {}),
      });
      return json(201, { project: projectView(listing) });
    }),
  );

  router.get("/api/projects/:projectId", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const listing = await catalog.getProject(context, params.projectId);
      return json(200, { project: projectView(listing) });
    }),
  );

  router.patch("/api/projects/:projectId", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const body = parseJsonBody(request.body);
      const updated = await catalog.updateProject(context, params.projectId, {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.slug === "string" ? { slug: body.slug } : {}),
      });
      return json(200, { project: projectFieldsView(updated) });
    }),
  );

  router.delete("/api/projects/:projectId", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      await catalog.deleteProject(context, params.projectId);
      return json(204, null);
    }),
  );

  /**
   * What the caller may do in this project.
   *
   * Advisory only: it spares the browser a round of failed writes and lets a UI
   * hide what it cannot do, but every operation re-checks authorization inside
   * its use case.
   */
  router.get("/api/projects/:projectId/access", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const access = await catalog.describeAccess(context, params.projectId);
      return json(200, access);
    }),
  );

  // ---- Membership -----------------------------------------------------------

  router.put(
    "/api/projects/:projectId/members/:userId",
    async (request, params) =>
      guarded(correlationId(request), async () => {
        const context = await contextOf(request);
        const body = parseJsonBody(request.body);
        const role = requireBodyString(body, "role");
        if (!isProjectRole(role)) {
          return errorResponse(
            422,
            "invalid",
            "The role must be OWNER, EDITOR or VIEWER.",
          );
        }
        await catalog.setMember(context, params.projectId, params.userId, role);
        return json(204, null);
      }),
  );

  router.delete(
    "/api/projects/:projectId/members/:userId",
    async (request, params) =>
      guarded(correlationId(request), async () => {
        const context = await contextOf(request);
        await catalog.removeMember(context, params.projectId, params.userId);
        return json(204, null);
      }),
  );

  // ---- Resources ------------------------------------------------------------

  router.get("/api/projects/:projectId/resources", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const resources = await catalog.listResources(context, params.projectId);
      return json(200, { resources: resources.map(resourceView) });
    }),
  );

  router.post("/api/projects/:projectId/resources", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const body = parseJsonBody(request.body);
      const type = requireBodyString(body, "type");
      if (
        type !== "sequence-diagram" &&
        type !== "event-flow" &&
        type !== "markdown-document"
      ) {
        return errorResponse(
          422,
          "invalid",
          "The type must be sequence-diagram, event-flow or markdown-document.",
        );
      }
      const resource = await catalog.createResource(context, params.projectId, {
        path: requireBodyString(body, "path"),
        type,
        content: typeof body.content === "string" ? body.content : "",
      });
      return json(201, { resource: resourceView(resource) });
    }),
  );

  router.get(
    "/api/projects/:projectId/resources/:resourceId",
    async (request, params) =>
      guarded(correlationId(request), async () => {
        const context = await contextOf(request);
        const { resource, content } = await catalog.readResource(
          context,
          params.projectId,
          params.resourceId,
        );
        return json(200, { resource: resourceView(resource), content });
      }),
  );

  /**
   * Replace a resource's content.
   *
   * `expectedRevision` is required, not optional. A PUT without one would be an
   * instruction to overwrite whatever is there, and an agent and a browser may
   * be editing the same document.
   */
  router.put(
    "/api/projects/:projectId/resources/:resourceId",
    async (request, params) =>
      guarded(correlationId(request), async () => {
        const context = await contextOf(request);
        const body = parseJsonBody(request.body);
        const resource = await catalog.updateResource(
          context,
          params.projectId,
          params.resourceId,
          {
            content: typeof body.content === "string" ? body.content : "",
            expectedRevision: requireExpectedRevision(body),
          },
        );
        return json(200, { resource: resourceView(resource) });
      }),
  );

  router.post(
    "/api/projects/:projectId/resources/:resourceId/move",
    async (request, params) =>
      guarded(correlationId(request), async () => {
        const context = await contextOf(request);
        const body = parseJsonBody(request.body);
        const resource = await catalog.moveResource(
          context,
          params.projectId,
          params.resourceId,
          {
            path: requireBodyString(body, "path"),
            expectedRevision: requireExpectedRevision(body),
          },
        );
        return json(200, { resource: resourceView(resource) });
      }),
  );

  router.delete(
    "/api/projects/:projectId/resources/:resourceId",
    async (request, params) =>
      guarded(correlationId(request), async () => {
        const context = await contextOf(request);
        await catalog.deleteResource(
          context,
          params.projectId,
          params.resourceId,
        );
        return json(204, null);
      }),
  );

  // ---- Agents and credential management ------------------------------------
  //
  // Cookie/session authenticated, so a credential cannot mint or revoke
  // credentials. The routes live in their own module because the surface has a
  // different threat model from project editing, not merely different URLs.
  registerAgentRoutes(router, dependencies);

  // ---- Remote MCP -----------------------------------------------------------
  //
  // A machine surface, authenticated exclusively by a bearer PAT. It reaches
  // the same catalog the routes above call, so an agent and a browser cannot
  // disagree about authorization, isolation or revisions.
  registerRemoteMcpRoutes(router, dependencies);

  return router;
}

/** The wire shape of a project listing. */
function projectView(listing: {
  project: {
    id: string;
    name: string;
    slug: string;
    ownerId: string;
    createdAt: Date;
    updatedAt: Date;
  };
  role: ProjectRole;
  resourceCount: number;
}): Record<string, unknown> {
  return {
    ...projectFieldsView(listing.project),
    role: listing.role,
    resourceCount: listing.resourceCount,
  };
}

/**
 * The wire shape of an authenticated principal.
 *
 * Exposed on `/api/me` so a machine client can learn which agent it is and
 * which user that agent acts for, without the API inventing a second identity
 * vocabulary.
 */
function principalView(context: {
  principal: {
    subjectUserId: string;
    actor: unknown;
    authType: string;
    scopes: readonly string[];
    displayName?: string;
    allowedProjectIds?: readonly string[];
  };
}): Record<string, unknown> {
  const principal = context.principal;
  return {
    subjectUserId: principal.subjectUserId,
    actor: principal.actor,
    authType: principal.authType,
    scopes: [...principal.scopes],
    displayName: principal.displayName ?? null,
    allowedProjectIds:
      principal.allowedProjectIds === undefined
        ? null
        : [...principal.allowedProjectIds],
  };
}
/** The fields every project response carries, whether or not it has a role. */
function projectFieldsView(project: {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    ownerId: project.ownerId,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

/** The wire shape of a resource. */
function resourceView(resource: {
  id: string;
  projectId: string;
  path: string;
  type: string;
  revision: number;
}): Record<string, unknown> {
  return {
    id: resource.id,
    projectId: resource.projectId,
    path: resource.path,
    type: resource.type,
    revision: resource.revision,
  };
}

/** Read a required string field of a JSON body. */
function requireBodyString(
  body: Record<string, unknown>,
  name: string,
): string {
  const value = body[name];
  if (typeof value !== "string" || value === "") {
    throw invalid(`The "${name}" field is required.`);
  }
  return value;
}

/**
 * Read the revision a write says it last saw.
 *
 * Required, not optional: a write that does not name a revision is a request to
 * overwrite whatever is there, and an agent and a browser may both be editing.
 */
function requireExpectedRevision(body: Record<string, unknown>): number {
  const value = body.expectedRevision;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid(
      "expectedRevision is required: send the revision you last read.",
    );
  }
  return value;
}
