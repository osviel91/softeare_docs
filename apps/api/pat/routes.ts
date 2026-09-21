/**
 * Personal Access Token management routes (Phase 5).
 *
 * These are the *browser-facing* token endpoints, and they are cookie/session
 * authenticated on purpose. The credential a machine uses and the credential a
 * human uses to mint one are deliberately different surfaces:
 *
 * ```
 * human  → OIDC → session cookie → POST /api/tokens → plaintext, once
 * machine→ PAT  → Authorization: Bearer … → POST /mcp
 * ```
 *
 * A PAT can never call these routes, so a leaked machine credential cannot mint
 * a replacement for itself. The lifecycle service enforces that independently of
 * the transport, which is why the check is not repeated here.
 *
 * Every mutation is a non-`GET` request, so the transport's cross-site check
 * (Fetch Metadata / `Origin`) already guards it, and every response that carries
 * metadata is built by {@link tokenView} — which has no field for a hash or a
 * secret. The plaintext appears in exactly one response shape: the 201 from
 * `POST /api/tokens`.
 */
import type { Router } from "../http/router";
import {
  errorResponse,
  json,
  parseJsonBody,
  type ServerRequest,
} from "../http/http";
import { guarded } from "../http/errors";
import { correlationId } from "../http/node-server";
import { requireContext } from "../context";
import { invalid } from "../../../src/application/errors";
import { PAT_SCOPES } from "../../../src/domain/access/permissions";
import type { PersonalAccessTokenRecord } from "../../../src/application/ports/personal-access-token-repository";
import type { AppDependencies } from "../app";

/** The wire shape of a token's metadata. Never carries a secret or a hash. */
function tokenView(record: PersonalAccessTokenRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: [...record.scopes],
    projectIds: record.projectIds === null ? null : [...record.projectIds],
    createdAt: record.createdAt.toISOString(),
    expiresAt:
      record.expiresAt === null ? null : record.expiresAt.toISOString(),
    lastUsedAt:
      record.lastUsedAt === null ? null : record.lastUsedAt.toISOString(),
    revokedAt:
      record.revokedAt === null ? null : record.revokedAt.toISOString(),
    revoked: record.revokedAt !== null,
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

/** Register the token management routes on a router. */
export function registerPersonalAccessTokenRoutes(
  router: Router,
  dependencies: AppDependencies,
): void {
  const { personalAccessTokens } = dependencies;
  const contextOf = (request: ServerRequest) =>
    requireContext(dependencies.sessions, request);

  router.get("/api/tokens", async (request) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const records = await personalAccessTokens.list(context);
      return json(200, {
        tokens: records.map(tokenView),
        // The closed scope vocabulary, so a client never hard-codes it.
        scopes: [...PAT_SCOPES],
      });
    }),
  );

  router.post("/api/tokens", async (request) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const body = parseJsonBody(request.body);
      const created = await personalAccessTokens.create(context, {
        name: requireString(body, "name"),
        scopes: requireStringArray(body, "scopes"),
        expiresAt: parseExpiry(body.expiresAt),
        projectIds: optionalStringArray(body, "projectIds") ?? null,
      });
      // The one response in the whole API that carries a plaintext credential.
      return json(201, {
        secret: created.token,
        token: tokenView(created.record),
      });
    }),
  );

  router.patch("/api/tokens/:tokenId", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const body = parseJsonBody(request.body);
      const updated = await personalAccessTokens.rename(
        context,
        params.tokenId,
        requireString(body, "name"),
      );
      return json(200, { token: tokenView(updated) });
    }),
  );

  router.delete("/api/tokens/:tokenId", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      await personalAccessTokens.revoke(context, params.tokenId);
      return json(204, null);
    }),
  );

  // A method that is not part of the lifecycle is refused explicitly rather
  // than falling through to the generic "no such route", because the path is
  // real and the mistake is the verb.
  router.get("/api/tokens/:tokenId", async (request, params) =>
    guarded(correlationId(request), async () => {
      const context = await contextOf(request);
      const records = await personalAccessTokens.list(context);
      const found = records.find((record) => record.id === params.tokenId);
      if (!found) {
        return errorResponse(
          404,
          "not_found",
          `No access token with id ${params.tokenId}.`,
        );
      }
      return json(200, { token: tokenView(found) });
    }),
  );
}

/**
 * Parse an optional `expiresAt`.
 *
 * A JSON `null` means "no expiry" (an explicit choice), an absent field means
 * the same, and anything else must be a valid ISO timestamp string. A number is
 * refused rather than guessed at, because "expires at 1700000000" is ambiguous
 * between seconds and milliseconds and getting it wrong is a security bug.
 */
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
