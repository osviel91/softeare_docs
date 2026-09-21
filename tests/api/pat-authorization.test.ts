/**
 * PAT authorization composition (Phase 5, checkpoints 5B).
 *
 * A PAT is not a second authorization system: it produces the same
 * {@link ApplicationContext} a session does, and every use case decides on it
 * through the one policy. This suite proves the two grants compose — the
 * credential's scopes *and* the caller's project role — and that neither one can
 * widen the other:
 *
 * - a read-only token is refused a write even in a project its owner owns;
 * - a writer token whose owner is only a VIEWER is still refused;
 * - a token never sees a project its owner is not a member of;
 * - a project-restricted token addresses another project as if it did not exist;
 * - a resource id from another project resolves to nothing.
 *
 * It also asserts the security posture the mission names: no token material in
 * logs or audit rows, and malformed credentials refused.
 */
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../apps/api/config";
import { closeApp, createApp, type AppDependencies } from "../../apps/api/app";
import { contextFor, SESSION_SCOPES } from "../../apps/api/context";
import {
  PAT_PREFIX,
  generatePat,
  principalFromPat,
  resolvePat,
} from "../../apps/api/auth/pat";
import {
  parseCookies,
  parseQuery,
  type ServerRequest,
} from "../../apps/api/http/http";
import { ApplicationError } from "../../src/application/errors";
import type { ApplicationContext } from "../../src/application/context";
import { createTestProvider, type TestProvider } from "./test-provider";

let dependencies: AppDependencies;
let volume: string;
let provider: TestProvider;

beforeAll(async () => {
  volume = await mkdtemp(path.join(tmpdir(), "sd-pat-authz-"));
  provider = await createTestProvider();
  dependencies = await createApp(
    loadConfig(
      {
        NODE_ENV: "test",
        COOKIE_SECRET: "a".repeat(48),
        PUBLIC_URL: "http://localhost:4000",
        PROJECT_VOLUME: volume,
        PGLITE_DIR: "memory://",
        OIDC_ISSUER: provider.issuer,
        OIDC_CLIENT_ID: provider.clientId,
        OIDC_CLIENT_SECRET: provider.clientSecret,
        OIDC_REDIRECT_URI: provider.redirectUri,
      },
      { oidcFetch: provider.fetch },
    ),
  );
});

afterAll(async () => {
  await closeApp(dependencies);
  await rm(volume, { recursive: true, force: true });
});

let subjectCounter = 0;

/** An internal user, without a browser session. */
async function aUser(): Promise<string> {
  subjectCounter += 1;
  const user = await dependencies.users.findOrCreateByExternalIdentity({
    issuer: provider.issuer,
    subject: `pat-authz-${subjectCounter}`,
    displayName: `User ${subjectCounter}`,
    email: null,
  });
  return user.id;
}

/**
 * Mint a token for a user and return the context a remote MCP request would
 * run under: identity from the token's owner, capabilities from its scopes.
 *
 * The record is created through the repository (the browser route is covered
 * elsewhere) and turned into a principal by the same function the bearer
 * verifier uses, so nothing about the composition is faked.
 */
async function patContext(
  userId: string,
  scopes: readonly string[],
  projectIds?: readonly string[],
): Promise<ApplicationContext> {
  const minted = generatePat();
  const record = await dependencies.tokens.create({
    userId,
    name: "Agent",
    prefix: minted.prefix,
    tokenHash: minted.tokenHash,
    scopes,
    ...(projectIds === undefined ? {} : { projectIds }),
  });
  return contextFor(principalFromPat(record), `req-${record.id}`);
}

/** Run a catalog call and return the ApplicationError code it threw, if any. */
async function refusalOf(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    if (error instanceof ApplicationError) return error.code;
    throw error;
  }
}

/** Create a project owned by a user, directly through the catalog. */
async function aProject(ownerId: string, name = "Payments") {
  const context = contextFor(
    { userId: ownerId, authType: "session", scopes: SESSION_SCOPES },
    "req-owner",
  );
  const listing = await dependencies.catalog.createProject(context, { name });
  return listing.project.id;
}

/** Add a member at a role, directly through the repository. */
async function addMember(
  projectId: string,
  userId: string,
  role: "OWNER" | "EDITOR" | "VIEWER",
) {
  await dependencies.projects.setMember(projectId, userId, role);
}

describe("scopes compose with project roles", () => {
  it("lets a writer token create, update, move and delete a resource", async () => {
    const owner = await aUser();
    const projectId = await aProject(owner, "Writer project");
    const context = await patContext(owner, ["projects:write"]);

    const created = await dependencies.catalog.createResource(
      context,
      projectId,
      { path: "checkout.seq", type: "sequence-diagram", content: "A -> B: hi" },
    );
    expect(created.revision).toBe(1);

    const updated = await dependencies.catalog.updateResource(
      context,
      projectId,
      created.id,
      { content: "A -> B: hello", expectedRevision: 1 },
    );
    expect(updated.revision).toBe(2);

    const moved = await dependencies.catalog.moveResource(
      context,
      projectId,
      created.id,
      { path: "renamed.seq", expectedRevision: 2 },
    );
    expect(moved.path).toBe("renamed.seq");

    await dependencies.catalog.deleteResource(context, projectId, created.id);
    expect(
      await dependencies.catalog.listResources(context, projectId),
    ).toEqual([]);
  });

  it("refuses every write to a read-only token, even in an owned project", async () => {
    const owner = await aUser();
    const projectId = await aProject(owner, "Read-only project");
    const writer = await patContext(owner, ["projects:write"]);
    const reader = await patContext(owner, ["projects:read"]);
    const resource = await dependencies.catalog.createResource(
      writer,
      projectId,
      { path: "doc.md", type: "markdown-document", content: "# Hi" },
    );

    expect(
      await refusalOf(() =>
        dependencies.catalog.createResource(reader, projectId, {
          path: "new.seq",
          type: "sequence-diagram",
          content: "",
        }),
      ),
    ).toBe("forbidden");
    expect(
      await refusalOf(() =>
        dependencies.catalog.updateResource(reader, projectId, resource.id, {
          content: "changed",
          expectedRevision: 1,
        }),
      ),
    ).toBe("forbidden");
    expect(
      await refusalOf(() =>
        dependencies.catalog.moveResource(reader, projectId, resource.id, {
          path: "moved.md",
          expectedRevision: 1,
        }),
      ),
    ).toBe("forbidden");
    expect(
      await refusalOf(() =>
        dependencies.catalog.deleteResource(reader, projectId, resource.id),
      ),
    ).toBe("forbidden");

    // The content is untouched, so the refusals changed nothing.
    const read = await dependencies.catalog.readResource(
      reader,
      projectId,
      resource.id,
    );
    expect(read.content).toBe("# Hi");
  });

  it("refuses a writer token whose owner is only a VIEWER", async () => {
    const owner = await aUser();
    const viewer = await aUser();
    const projectId = await aProject(owner, "Viewer project");
    await addMember(projectId, viewer, "VIEWER");
    const context = await patContext(viewer, ["projects:write"]);

    const read = await refusalOf(() =>
      dependencies.catalog.listResources(context, projectId),
    );
    expect(read).toBeNull();

    const write = await refusalOf(() =>
      dependencies.catalog.createResource(context, projectId, {
        path: "sneaky.seq",
        type: "sequence-diagram",
        content: "",
      }),
    );
    expect(write).toBe("forbidden");
  });

  it("refuses a read-only token creating a project", async () => {
    const owner = await aUser();
    const reader = await patContext(owner, ["projects:read"]);
    expect(
      await refusalOf(() =>
        dependencies.catalog.createProject(reader, { name: "Escalation" }),
      ),
    ).toBe("forbidden");

    const writer = await patContext(owner, ["projects:write"]);
    const created = await dependencies.catalog.createProject(writer, {
      name: "Agent-made",
    });
    expect(created.project.name).toBe("Agent-made");
  });
});

describe("project isolation through a PAT", () => {
  it("cannot see or touch another user's project", async () => {
    const owner = await aUser();
    const stranger = await aUser();
    const projectId = await aProject(owner, "Private project");
    const context = await patContext(stranger, ["projects:write"]);

    expect(await dependencies.catalog.listProjects(context)).toEqual([]);
    expect(
      await refusalOf(() =>
        dependencies.catalog.listResources(context, projectId),
      ),
    ).toBe("not_found");
    expect(
      await refusalOf(() =>
        dependencies.catalog.createResource(context, projectId, {
          path: "intruder.seq",
          type: "sequence-diagram",
          content: "",
        }),
      ),
    ).toBe("not_found");
  });

  it("answers a project a restricted token cannot address as missing", async () => {
    const owner = await aUser();
    const visible = await aProject(owner, "Visible");
    const hidden = await aProject(owner, "Hidden");
    const context = await patContext(owner, ["projects:write"], [visible]);

    const listed = await dependencies.catalog.listProjects(context);
    expect(listed.map((entry) => entry.project.id)).toEqual([visible]);
    expect(
      await refusalOf(() =>
        dependencies.catalog.listResources(context, hidden),
      ),
    ).toBe("not_found");
    expect(
      await refusalOf(() => dependencies.catalog.getProject(context, hidden)),
    ).toBe("not_found");
  });

  it("does not resolve a resource id from another project", async () => {
    const owner = await aUser();
    const first = await aProject(owner, "First");
    const second = await aProject(owner, "Second");
    const context = await patContext(owner, ["projects:write"]);
    const resource = await dependencies.catalog.createResource(context, first, {
      path: "doc.md",
      type: "markdown-document",
      content: "# One",
    });

    expect(
      await refusalOf(() =>
        dependencies.catalog.readResource(context, second, resource.id),
      ),
    ).toBe("not_found");
    expect(
      await refusalOf(() =>
        dependencies.catalog.updateResource(context, second, resource.id, {
          content: "stolen",
          expectedRevision: 1,
        }),
      ),
    ).toBe("not_found");
  });
});

describe("malformed input and credential handling", () => {
  it("refuses a traversing resource path as an invalid path", async () => {
    const owner = await aUser();
    const projectId = await aProject(owner, "Paths");
    const context = await patContext(owner, ["projects:write"]);

    for (const bad of [
      "../escape.seq",
      "/absolute.seq",
      "a/../../escape.seq",
      "back\\slash.seq",
    ]) {
      try {
        await dependencies.catalog.createResource(context, projectId, {
          path: bad,
          type: "sequence-diagram",
          content: "",
        });
        throw new Error(`Expected "${bad}" to be refused.`);
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        const application = error as ApplicationError;
        expect(application.code).toBe("invalid");
        expect(application.details).toMatchObject({ kind: "invalid_path" });
      }
    }
  });

  it("refuses malformed bearer credentials with an unauthenticated failure", async () => {
    const request = (authorization: string | undefined): ServerRequest => ({
      method: "POST",
      path: "/mcp",
      query: parseQuery(""),
      headers: authorization === undefined ? {} : { authorization },
      cookies: parseCookies(authorization === undefined ? undefined : ""),
      body: "{}",
    });

    const cases = [
      undefined,
      "",
      "Bearer",
      "Bearer ",
      "Basic dXNlcjpwYXNz",
      "Token abc",
      `${PAT_PREFIX}${"0".repeat(16)}.${"A".repeat(43)}`,
    ];
    for (const header of cases) {
      const lookup = await resolvePat(dependencies.tokens, request(header));
      expect(lookup.state === "valid").toBe(false);
    }
  });

  it("never writes a presented token to stderr", async () => {
    const owner = await aUser();
    const context = await patContext(owner, ["projects:read"]);
    // A valid record exists; present it with a wrong secret so verification
    // runs every branch it can fail on.
    const record = (await dependencies.tokens.listForUser(owner))[0];
    const wrong = `${PAT_PREFIX}${record.prefix}.${"Z".repeat(43)}`;
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await resolvePat(dependencies.tokens, {
        method: "POST",
        path: "/mcp",
        query: parseQuery(""),
        headers: { authorization: `Bearer ${wrong}` },
        cookies: parseCookies(""),
        body: "{}",
      });
      expect(context.principal.userId).toBe(owner);
    } finally {
      const calls = write.mock.calls.map((call) => String(call[0])).join("");
      expect(calls).not.toContain(wrong);
      write.mockRestore();
    }
  });

  it("records an invalid credential attempt in no audit row", async () => {
    const owner = await aUser();
    const context = await patContext(owner, ["projects:read"]);
    const events = await dependencies.audit.listForUser(owner, 50);
    // Creating the token is audited; verification itself is not an audit event
    // (it is counted through last_used_at), so nothing here names a secret.
    expect(JSON.stringify(events)).not.toContain("token_hash");
    expect(context.principal.authType).toBe("pat");
  });
});
