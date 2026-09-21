/**
 * Agent and credential management routes (ADR-043, Phase 5 §22).
 *
 * These are the *browser-facing* settings endpoints, and they are cookie/session
 * authenticated on purpose. The credential a machine uses and the credential a
 * human uses to mint one are deliberately different surfaces:
 *
 * ```
 * human  → OIDC → session cookie → POST /api/agents/:id/credentials → secret, once
 * machine→ token → Authorization: Bearer … → /api/projects… and /mcp
 * ```
 *
 * A credential can never call these routes: the converged authenticator is not
 * used here, and the service additionally requires `agent:manage` /
 * `credential:manage`, which no default credential carries. The lifecycle
 * service enforces that independently of the transport, which is why the check
 * is not repeated here.
 *
 * Every mutation is a non-`GET` request, so the transport's cross-site check
 * (Fetch Metadata / `Origin`) already guards it, and every response that carries
 * metadata is built by {@link credentialView} / {@link agentView} — which have
 * no field for a hash or a secret. The plaintext appears in exactly two
 * responses: the 201 from credential creation and from rotation.
 */
import type { Router } from "../http/router";
import { json, parseJsonBody, type ServerRequest } from "../http/http";
import { guarded } from "../http/errors";
import { correlationId } from "../http/node-server";
import { requireContext } from "../context";
import { invalid } from "../../../src/application/errors";
import {
  ADMIN_PERMISSIONS,
  CREDENTIAL_SCOPES,
  DEFAULT_CREDENTIAL_SCOPES,
  RESOURCE_WRITE_SCOPE,
} from "../../../src/domain/access/permissions";
import type {
  AgentCredential,
  AgentIdentity,
} from "../../../src/domain/agent/agent";
import type { AppDependencies } from "../app";

/**
 * The scopes the settings screen offers.
 *
 * Administrative scopes are filtered out: they are accepted by the service when
 * an owner sends them explicitly, but the normal credential-creation surface
 * does not advertise or tick them (mission §11).
 */
const OFFERED_SCOPES = CREDENTIAL_SCOPES.filter(
  (scope) =>
    scope === RESOURCE_WRITE_SCOPE ||
    !(ADMIN_PERMISSIONS as readonly string[]).includes(scope),
);

/** The wire shape of an agent identity. */
function agentView(agent: AgentIdentity): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    disabledAt:
      agent.disabledAt === null ? null : agent.disabledAt.toISOString(),
    disabled: agent.disabledAt !== null,
  };
}

/** The wire shape of a credential's metadata. Never a secret or a hash. */
function credentialView(
  credential: AgentCredential,
  status: string,
): Record<string, unknown> {
  return {
    id: credential.id,
    agentId: credential.agentId,
    name: credential.name,
    prefix: credential.publicPrefix,
    scopes: [...credential.scopes],
    allowedProjectIds:
      credential.allowedProjectIds === null
        ? null
        : [...credential.allowedProjectIds],
    createdAt: credential.createdAt.toISOString(),
    expiresAt:
      credential.expiresAt === null ? null : credential.expiresAt.toISOString(),
    lastUsedAt:
      credential.lastUsedAt === null
        ? null
        : credential.lastUsedAt.toISOString(),
    revokedAt:
      credential.revokedAt === null ? null : credential.revokedAt.toISOString(),
    status,
  };
}

/** Read a required non-empty string field. */
function requireString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`The "${name}" field is required.`);
  }
  return value;
}

/** Read a required array of strings. */
function requireStringArray(
  body: Record<string, unknown>,
  name: string,
): string[] {
  const value = body[name];
  if (!Array.isArray(value)) {
    throw invalid(`The "${name}" field must be an array.`);
  }
  return value.map((entry) => String(entry));
}

/** Read an optional array of strings, distinguishing absent from empty. */
function optionalStringArray(
  body: Record<string, unknown>,
  name: string,
): string[] | undefined {
  if (body[name] === undefined || body[name] === null) return undefined;
  return requireStringArray(body, name);
}

/** Parse an optional `expiresAt` (an ISO string, or `null` for no expiry). */
function parseExpiry(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid("expiresAt must be an ISO timestamp string or null.");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw invalid("expiresAt must be a valid ISO timestamp.");
  }
  return parsed;
}

/** Register the agent management routes on a router. */
export function registerAgentRoutes(
  router: Router,
  dependencies: AppDependencies,
): void {
  const { agents } = dependencies;
  const contextOf = (request: ServerRequest) =>
    requireContext(dependencies.sessions, request);

  router.get("/api/agents", async (request) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const summaries = await agents.listAgents(context);
      return json(200, {
        agents: summaries.map((summary) => ({
          ...agentView(summary.agent),
          credentialCount: summary.credentialCount,
          activeCredentialCount: summary.activeCredentialCount,
        })),
        scopes: [...OFFERED_SCOPES],
        defaultScopes: [...DEFAULT_CREDENTIAL_SCOPES],
      });
    }),
  );

  router.post("/api/agents", async (request) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const body = parseJsonBody(request.body);
      const created = await agents.createAgent(context, {
        name: requireString(body, "name"),
        description:
          typeof body.description === "string" ? body.description : null,
      });
      return json(201, { agent: agentView(created) });
    }),
  );

  router.patch("/api/agents/:agentId", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const body = parseJsonBody(request.body);
      const updated = await agents.renameAgent(context, params.agentId, {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(body.description === undefined
          ? {}
          : {
              description:
                typeof body.description === "string" ? body.description : null,
            }),
      });
      return json(200, { agent: agentView(updated) });
    }),
  );

  /**
   * Disable (or re-enable) an agent.
   *
   * `DELETE` disables rather than hard-deletes, because disabling invalidates
   * every credential immediately while leaving the audit trail's actor intact.
   */
  router.delete("/api/agents/:agentId", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const updated = await agents.setAgentDisabled(
        context,
        params.agentId,
        true,
      );
      return json(200, { agent: agentView(updated) });
    }),
  );

  router.post("/api/agents/:agentId/enable", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const updated = await agents.setAgentDisabled(
        context,
        params.agentId,
        false,
      );
      return json(200, { agent: agentView(updated) });
    }),
  );

  router.get("/api/agents/:agentId/credentials", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const summaries = await agents.listCredentials(context, params.agentId);
      return json(200, {
        credentials: summaries.map((summary) =>
          credentialView(summary.credential, summary.status),
        ),
        scopes: [...OFFERED_SCOPES],
        defaultScopes: [...DEFAULT_CREDENTIAL_SCOPES],
      });
    }),
  );

  router.post("/api/agents/:agentId/credentials", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const body = parseJsonBody(request.body);
      const created = await agents.createCredential(context, params.agentId, {
        name: requireString(body, "name"),
        scopes: requireStringArray(body, "scopes"),
        expiresAt: parseExpiry(body.expiresAt),
        allowedProjectIds:
          optionalStringArray(body, "allowedProjectIds") ?? null,
      });
      // The one response in the whole API that carries a plaintext credential.
      return json(201, {
        secret: created.token,
        credential: credentialView(created.credential, "active"),
      });
    }),
  );

  router.post(
    "/api/agents/:agentId/credentials/:credentialId/rotate",
    async (request, params) =>
      guarded(correlationId(request), async () => {
        const context = await contextOf(request);
        const rotated = await agents.rotateCredential(
          context,
          params.agentId,
          params.credentialId,
        );
        return json(201, {
          secret: rotated.token,
          credential: credentialView(rotated.credential, "active"),
          replacedCredentialId: params.credentialId,
        });
      }),
  );

  router.delete(
    "/api/agents/:agentId/credentials/:credentialId",
    async (request, params) =>
      guarded(correlationId(request), async () => {
        const context = await contextOf(request);
        await agents.revokeCredential(
          context,
          params.agentId,
          params.credentialId,
        );
        return json(204, null);
      }),
  );
}

/** Exported for a test that asserts the offered list has no admin scope. */
export { OFFERED_SCOPES };
