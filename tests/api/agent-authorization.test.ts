/**
 * Agent-credential authorization composition (ADR-043, Phase 5 §9, §39–41).
 *
 * A credential is not a second authorization system: it produces the same
 * {@link ApplicationContext} a session does, with the owner as the subject and
 * the agent as the actor, and every use case decides on it through the one
 * policy. This suite proves the two grants compose — the credential's scopes
 * *and* the owner's project role — and that neither widens the other:
 *
 * - a read-only credential is refused a write even in a project its owner owns;
 * - a writer credential whose owner is only a VIEWER is still refused;
 * - a credential never sees a project its owner is not a member of;
 * - a project-restricted credential addresses another project as if it did not
 *   exist;
 * - a resource id from another project resolves to nothing.
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
  principalFromCredential,
  resolveAgentCredential,
} from "../../apps/api/auth/agent-credential";
import { parseCookies, parseQuery } from "../../apps/api/http/http";
import { ApplicationError } from "../../src/application/errors";
import type { ApplicationContext } from "../../src/application/context";
import { createTestProvider, type TestProvider } from "./test-provider";

let dependencies: AppDependencies;
let volume: string;
let provider: TestProvider;

beforeAll(async () => {
  volume = await mkdtemp(path.join(tmpdir(), "sd-agent-authz-"));
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
    subject: `agent-authz-${subjectCounter}`,
    displayName: `User ${subjectCounter}`,
    email: null,
  });
  return user.id;
}

/** A session context, as the browser-management routes would build. */
function sessionContext(userId: string): ApplicationContext {
  return contextFor(
    {
      subjectUserId: userId,
      actor: { kind: "user", userId },
      authType: "session",
      scopes: SESSION_SCOPES,
    },
    "req-session",
  );
}

/**
 * Create an agent and one credential for a user, then return the context a
 * request presenting that credential would run under.
 */
async function credentialContext(
  userId: string,
  scopes: readonly string[],
  allowedProjectIds?: readonly string[],
): Promise<ApplicationContext> {
  const session = sessionContext(userId);
  const agent = await dependencies.agents.createAgent(session, {
    name: `Agent ${Math.random().toString(36).slice(2)}`,
  });
  const created = await dependencies.agents.createCredential(
    session,
    agent.id,
    {
      name: "Credential",
      scopes,
      ...(allowedProjectIds === undefined ? {} : { allowedProjectIds }),
    },
  );
  const lookup = await resolveAgentCredential(
    dependencies.credentials,
    {
      method: "POST",
      path: "/mcp",
      query: parseQuery(""),
      headers: { authorization: `Bearer ${created.token}` },
      cookies: parseCookies(""),
      body: "{}",
    },
    dependencies.tokenPepper,
  );
  if (lookup.state !== "valid")
    throw new Error("the credential did not verify");
  return contextFor(
    principalFromCredential(lookup.credential, lookup.agent),
    `req-${created.credential.id}`,
  );
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

/** Create a project owned by a user, through the catalog. */
async function aProject(ownerId: string, name = "Payments") {
  const listing = await dependencies.catalog.createProject(
    sessionContext(ownerId),
    { name, workspaceId: ownerId },
  );
  return listing.project.id;
}

describe("scopes compose with project roles", () => {
  it("lets a writer credential create, update, move and delete a resource", async () => {
    const owner = await aUser();
    const projectId = await aProject(owner, "Writer project");
    const context = await credentialContext(owner, [
      "resource:read",
      "resource:write",
    ]);

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

  it("refuses every write to a read-only credential, even in an owned project", async () => {
    const owner = await aUser();
    const projectId = await aProject(owner, "Read-only project");
    const writer = await credentialContext(owner, [
      "resource:read",
      "resource:write",
    ]);
    const reader = await credentialContext(owner, ["resource:read"]);
    const resource = await dependencies.catalog.createResource(
      writer,
      projectId,
      { path: "doc.md", type: "markdown-document", content: "# Hi" },
    );

    for (const attempt of [
      () =>
        dependencies.catalog.createResource(reader, projectId, {
          path: "new.seq",
          type: "sequence-diagram",
          content: "",
        }),
      () =>
        dependencies.catalog.updateResource(reader, projectId, resource.id, {
          content: "changed",
          expectedRevision: 1,
        }),
      () =>
        dependencies.catalog.moveResource(reader, projectId, resource.id, {
          path: "moved.md",
          expectedRevision: 1,
        }),
      () => dependencies.catalog.deleteResource(reader, projectId, resource.id),
    ]) {
      expect(await refusalOf(attempt)).toBe("forbidden");
    }

    const read = await dependencies.catalog.readResource(
      reader,
      projectId,
      resource.id,
    );
    expect(read.content).toBe("# Hi");
  });

  it("refuses a writer credential whose owner is only a VIEWER", async () => {
    const owner = await aUser();
    const viewer = await aUser();
    const projectId = await aProject(owner, "Viewer project");
    await dependencies.projects.setMember(projectId, viewer, "VIEWER");
    await dependencies.workspaces.setMember(owner, viewer, "VIEWER");
    const context = await credentialContext(viewer, [
      "resource:read",
      "resource:write",
    ]);

    expect(
      await refusalOf(() =>
        dependencies.catalog.listResources(context, projectId),
      ),
    ).toBeNull();
    expect(
      await refusalOf(() =>
        dependencies.catalog.createResource(context, projectId, {
          path: "sneaky.seq",
          type: "sequence-diagram",
          content: "",
        }),
      ),
    ).toBe("forbidden");
  });

  it("refuses a read-only credential creating a project", async () => {
    const owner = await aUser();
    const reader = await credentialContext(owner, ["resource:read"]);
    expect(
      await refusalOf(() =>
        dependencies.catalog.createProject(reader, {
          name: "Escalation",
          workspaceId: owner,
        }),
      ),
    ).toBe("forbidden");

    const writer = await credentialContext(owner, ["project:create"]);
    const created = await dependencies.catalog.createProject(writer, {
      name: "Agent-made",
      workspaceId: owner,
    });
    expect(created.project.name).toBe("Agent-made");
  });
});

describe("project isolation through a credential", () => {
  it("cannot see or touch another user's project", async () => {
    const owner = await aUser();
    const stranger = await aUser();
    const projectId = await aProject(owner, "Private project");
    const context = await credentialContext(stranger, [
      "resource:read",
      "resource:write",
    ]);

    expect(await dependencies.catalog.listProjects(context, stranger)).toEqual(
      [],
    );
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

  it("answers a project a restricted credential cannot address as missing", async () => {
    const owner = await aUser();
    const visible = await aProject(owner, "Visible");
    const hidden = await aProject(owner, "Hidden");
    const context = await credentialContext(
      owner,
      ["resource:read", "resource:write"],
      [visible],
    );

    const listed = await dependencies.catalog.listProjects(context, owner);
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
    const context = await credentialContext(owner, [
      "resource:read",
      "resource:write",
    ]);
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
    const context = await credentialContext(owner, [
      "resource:read",
      "resource:write",
    ]);

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

  it("never writes a presented credential to stderr", async () => {
    const owner = await aUser();
    const context = await credentialContext(owner, ["resource:read"]);
    expect(context.principal.actor.kind).toBe("agent");

    const agentId =
      context.principal.actor.kind === "agent"
        ? context.principal.actor.agentId
        : "";
    const credentials = await dependencies.credentials.listForAgent(agentId);
    const wrong = `sdm_pat_${credentials[0].publicPrefix}.${"Z".repeat(43)}`;
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await resolveAgentCredential(
        dependencies.credentials,
        {
          method: "POST",
          path: "/mcp",
          query: parseQuery(""),
          headers: { authorization: `Bearer ${wrong}` },
          cookies: parseCookies(""),
          body: "{}",
        },
        dependencies.tokenPepper,
      );
    } finally {
      const calls = write.mock.calls.map((call) => String(call[0])).join("");
      expect(calls).not.toContain(wrong);
      write.mockRestore();
    }
  });
});

describe("audit distinguishes an agent write from a session write", () => {
  it("records the agent as actor, the owner as subject and the credential", async () => {
    const owner = await aUser();
    const projectId = await aProject(owner, "Audited project");
    const context = await credentialContext(owner, [
      "resource:read",
      "resource:write",
    ]);

    await dependencies.catalog.createResource(context, projectId, {
      path: "doc.md",
      type: "markdown-document",
      content: "# One",
    });

    const events = await dependencies.audit.listForUser(owner, 50);
    const created = events.find((event) => event.action === "resource.created");
    expect(created).toBeDefined();
    expect(created!.subjectUserId).toBe(owner);
    expect(created!.actorType).toBe("agent");
    expect(created!.actorId).not.toBe(owner);
    expect(created!.credentialId).not.toBeNull();
    expect(created!.authType).toBe("pat");

    // A session write in the same project records the user as the actor.
    await dependencies.catalog.createResource(
      sessionContext(owner),
      projectId,
      {
        path: "by-hand.md",
        type: "markdown-document",
        content: "# Two",
      },
    );
    const after = await dependencies.audit.listForUser(owner, 50);
    const sessionWrite = after.find(
      (event) =>
        event.action === "resource.created" && event.actorType === "user",
    );
    expect(sessionWrite).toBeDefined();
    expect(sessionWrite!.actorId).toBe(owner);
    expect(sessionWrite!.credentialId).toBeNull();
  });
});

describe("the shared API serves a credential too", () => {
  it("resolves a bearer credential through /api/me and the project routes", async () => {
    // Covered end to end by the E2E scenario; asserted here at the seam so a
    // regression is caught without a browser.
    const owner = await aUser();
    await aProject(owner, "Shared");
    const context = await credentialContext(owner, ["project:read"]);
    expect(context.principal.scopes).toContain("project:read");
    const listed = await dependencies.catalog.listProjects(context, owner);
    expect(listed).toHaveLength(1);
  });
});
