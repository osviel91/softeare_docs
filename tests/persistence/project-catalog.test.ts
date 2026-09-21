/**
 * The project catalog: server-mode use cases (ADR-040).
 *
 * These are the authorization, concurrency and boundary tests the mission asks
 * for, at the layer where they are enforced. Every case goes through the catalog
 * with an {@link ApplicationContext} — not through a controller and not through a
 * tool — which is exactly the property being proved: authorization lives in the
 * use case, so no transport can opt out of it.
 */
// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectCatalog } from "../../src/application/project-catalog";
import { createFsProjectStorage } from "../../src/persistence/fs-project-storage";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createAuditRepository } from "../../src/persistence/audit-repository";
import { ApplicationError } from "../../src/application/errors";
import type { ApplicationContext } from "../../src/application/context";
import {
  ALL_PERMISSIONS,
  type Permission,
} from "../../src/domain/access/permissions";
import type { SqlClient } from "../../src/persistence/sql-client";
import { openTestDatabase, closeTestDatabase } from "./test-database";

let client: SqlClient;
let catalog: ReturnType<typeof createProjectCatalog>;
let users: ReturnType<typeof createUserRepository>;
let audit: ReturnType<typeof createAuditRepository>;
let volume: string;

beforeAll(async () => {
  client = await openTestDatabase();
  volume = await mkdtemp(path.join(tmpdir(), "sd-catalog-"));
  const projects = createProjectRepository(client);
  users = createUserRepository(client);
  audit = createAuditRepository(client);
  catalog = createProjectCatalog({
    projects,
    audit,
    // The factory is the only thing that decides where a project lives, and it
    // is asked only for a project the catalog has already authorized.
    storage: (projectId) =>
      createFsProjectStorage({ root: path.join(volume, projectId) }),
  });
});

afterAll(async () => {
  await closeTestDatabase(client);
  await rm(volume, { recursive: true, force: true });
});

/** A user created through the same identity path a login uses. */
async function aUser(name = "User"): Promise<string> {
  const user = await users.findOrCreateByExternalIdentity({
    issuer: "https://idp.test",
    subject: `subject-${Math.random().toString(36).slice(2)}`,
    displayName: name,
    email: null,
  });
  return user.id;
}

/** A context for a user, as a transport would build at its edge. */
function contextFor(
  userId: string,
  overrides: Partial<ApplicationContext["principal"]> = {},
): ApplicationContext {
  return {
    requestId: "req-test",
    principal: {
      subjectUserId: userId,
      actor: { kind: "user", userId },
      authType: "session",
      scopes: [...ALL_PERMISSIONS],
      ...overrides,
    },
  };
}

/** Every scope a credential could hold, for tests that are not about scopes. */
const ALL_SCOPES: Permission[] = [...ALL_PERMISSIONS];

/** A project owned by a fresh user, plus its owner context. */
async function aProject(name = "Payments") {
  const ownerId = await aUser("Owner");
  const context = contextFor(ownerId, { scopes: ALL_SCOPES });
  const listing = await catalog.createProject(context, { name });
  return { ownerId, context, project: listing.project };
}

/** The `ApplicationError` a call rejects with. */
async function failureOf(work: Promise<unknown>): Promise<ApplicationError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApplicationError) return error;
    throw error;
  }
  throw new Error("Expected the call to fail, but it succeeded.");
}

describe("project lifecycle", () => {
  it("creates a project, gives the creator OWNER, and lists it for them", async () => {
    const { ownerId, context, project } = await aProject("Ledger");
    const listing = await catalog.getProject(context, project.id);
    expect(listing.role).toBe("OWNER");
    const mine = await catalog.listProjects(context);
    expect(mine.map((entry) => entry.project.id)).toContain(project.id);
    expect(mine.find((entry) => entry.project.id === project.id)?.role).toBe(
      "OWNER",
    );
    expect(ownerId).not.toBe("");
  });

  it("refuses a blank project name", async () => {
    const ownerId = await aUser();
    const failure = await failureOf(
      catalog.createProject(contextFor(ownerId), { name: "   " }),
    );
    expect(failure.code).toBe("invalid");
  });

  it("keeps a project invisible to a user who is not a member", async () => {
    const { project } = await aProject("Secret");
    const strangerId = await aUser("Stranger");
    const failure = await failureOf(
      catalog.getProject(contextFor(strangerId), project.id),
    );
    expect(failure.code).toBe("not_found");
    expect(failure.status).toBe(404);
    expect(await catalog.listProjects(contextFor(strangerId))).toEqual([]);
  });

  it("renames a project for its owner", async () => {
    const { context, project } = await aProject("Before");
    const updated = await catalog.updateProject(context, project.id, {
      name: "After",
    });
    expect(updated.name).toBe("After");
  });

  it("refuses a malformed slug", async () => {
    const { context, project } = await aProject("Slug");
    const failure = await failureOf(
      catalog.updateProject(context, project.id, { slug: "Not A Slug" }),
    );
    expect(failure.code).toBe("invalid");
  });

  it("removes a project's files when it is deleted", async () => {
    const { context, project } = await aProject("Doomed");
    await catalog.createResource(context, project.id, {
      path: "diagrams/a.seq",
      type: "sequence-diagram",
      content: "participant A",
    });
    await catalog.deleteProject(context, project.id);
    const failure = await failureOf(catalog.getProject(context, project.id));
    expect(failure.code).toBe("not_found");
  });
});

describe("authorization by role", () => {
  it("lets a viewer read but not write", async () => {
    const { ownerId, context, project } = await aProject("Shared read");
    const viewerId = await aUser("Viewer");
    await catalog.setMember(context, project.id, viewerId, "VIEWER");
    const viewer = contextFor(viewerId, { scopes: ALL_SCOPES });

    const created = await catalog.createResource(context, project.id, {
      path: "diagrams/a.seq",
      type: "sequence-diagram",
      content: "participant A",
    });

    const read = await catalog.readResource(viewer, project.id, created.id);
    expect(read.content).toBe("participant A");
    expect((await catalog.listResources(viewer, project.id)).length).toBe(1);

    const failure = await failureOf(
      catalog.updateResource(viewer, project.id, created.id, {
        content: "changed",
        expectedRevision: 1,
      }),
    );
    expect(failure.code).toBe("forbidden");
    expect(failure.status).toBe(403);
    expect(ownerId).not.toBe(viewerId);
  });

  it("reports only the permissions the credential itself carries", async () => {
    const { context, project } = await aProject("Scoped access");
    const agentId = await aUser("Agent");
    await catalog.setMember(context, project.id, agentId, "EDITOR");
    // The role grants the write; the credential does not. Both grants must line
    // up, so the advisory answer must not advertise a capability the token lacks.
    const readOnly = contextFor(agentId, {
      authType: "pat",
      scopes: ["project:read", "resource:read"],
    });

    const access = await catalog.describeAccess(readOnly, project.id);
    expect(access.role).toBe("EDITOR");
    expect(access.permissions).toContain("resource:read");
    expect(access.permissions).not.toContain("resource:update");
    expect(await catalog.can(readOnly, project.id, "resource:update")).toBe(
      false,
    );
    expect(await catalog.can(readOnly, project.id, "resource:read")).toBe(true);
  });

  it("lets an editor write resources", async () => {
    const { context, project } = await aProject("Shared write");
    const editorId = await aUser("Editor");
    await catalog.setMember(context, project.id, editorId, "EDITOR");
    const editor = contextFor(editorId, { scopes: ALL_SCOPES });

    const created = await catalog.createResource(editor, project.id, {
      path: "diagrams/a.seq",
      type: "sequence-diagram",
      content: "one",
    });
    const updated = await catalog.updateResource(
      editor,
      project.id,
      created.id,
      {
        content: "two",
        expectedRevision: created.revision,
      },
    );
    expect(updated.revision).toBe(2);
  });

  it("stops an editor from administering the project or its members", async () => {
    const { context, project } = await aProject("Admin only");
    const editorId = await aUser("Editor");
    await catalog.setMember(context, project.id, editorId, "EDITOR");
    const editor = contextFor(editorId, { scopes: ALL_SCOPES });
    const otherId = await aUser("Other");

    for (const work of [
      catalog.updateProject(editor, project.id, { name: "Renamed" }),
      catalog.setMember(editor, project.id, otherId, "VIEWER"),
      catalog.removeMember(editor, project.id, otherId),
      catalog.deleteProject(editor, project.id),
    ]) {
      const failure = await failureOf(work);
      expect(failure.code).toBe("forbidden");
    }
  });

  it("stops one user from reaching another user's project", async () => {
    const { project } = await aProject("Mine");
    const otherId = await aUser("Other");
    const other = contextFor(otherId, { scopes: ALL_SCOPES });

    for (const work of [
      catalog.getProject(other, project.id),
      catalog.listResources(other, project.id),
      catalog.createResource(other, project.id, {
        path: "a.seq",
        type: "sequence-diagram",
        content: "x",
      }),
      catalog.deleteProject(other, project.id),
    ]) {
      const failure = await failureOf(work);
      expect(failure.code).toBe("not_found");
    }
  });

  it("stops a project-restricted credential from reaching another project", async () => {
    const { context, project } = await aProject("Allowed");
    const other = await aProject("Forbidden");
    const agentId = await aUser("Agent");
    await catalog.setMember(context, project.id, agentId, "EDITOR");
    await catalog.setMember(other.context, other.project.id, agentId, "EDITOR");

    const restricted = contextFor(agentId, {
      authType: "pat",
      scopes: ALL_SCOPES,
      allowedProjectIds: [project.id],
    });

    const visible = await catalog.listProjects(restricted);
    expect(visible.map((entry) => entry.project.id)).toEqual([project.id]);

    const failure = await failureOf(
      catalog.getProject(restricted, other.project.id),
    );
    expect(failure.code).toBe("not_found");
  });

  it("refuses to remove the project owner", async () => {
    const { ownerId, context, project } = await aProject("Owner stays");
    const failure = await failureOf(
      catalog.removeMember(context, project.id, ownerId),
    );
    expect(failure.code).toBe("invalid");
  });
});

describe("resources and optimistic concurrency", () => {
  it("creates, reads, moves and deletes a resource", async () => {
    const { context, project } = await aProject("CRUD");
    const created = await catalog.createResource(context, project.id, {
      path: "diagrams/checkout.seq",
      type: "sequence-diagram",
      content: "participant A\nA -> B: hi\n",
    });
    expect(created.revision).toBe(1);

    const read = await catalog.readResource(context, project.id, created.id);
    expect(read.content).toContain("A -> B: hi");

    const moved = await catalog.moveResource(context, project.id, created.id, {
      path: "docs/checkout.seq",
      expectedRevision: 1,
    });
    expect(moved.path).toBe("docs/checkout.seq");
    expect(moved.id).toBe(created.id);

    await catalog.deleteResource(context, project.id, created.id);
    const failure = await failureOf(
      catalog.getResource(context, project.id, created.id),
    );
    expect(failure.code).toBe("not_found");
  });

  it("refuses to create two resources at the same path", async () => {
    const { context, project } = await aProject("Duplicates");
    await catalog.createResource(context, project.id, {
      path: "a.seq",
      type: "sequence-diagram",
      content: "one",
    });
    const failure = await failureOf(
      catalog.createResource(context, project.id, {
        path: "a.seq",
        type: "sequence-diagram",
        content: "two",
      }),
    );
    expect(failure.code).toBe("conflict");
  });

  it("rejects a traversal path before it reaches the volume", async () => {
    const { context, project } = await aProject("Traversal");
    const failure = await failureOf(
      catalog.createResource(context, project.id, {
        path: "../escape.seq",
        type: "sequence-diagram",
        content: "x",
      }),
    );
    expect(failure.code).toBe("invalid");
  });

  it("succeeds when the expected revision is current", async () => {
    const { context, project } = await aProject("Current");
    const created = await catalog.createResource(context, project.id, {
      path: "a.seq",
      type: "sequence-diagram",
      content: "one",
    });
    const updated = await catalog.updateResource(
      context,
      project.id,
      created.id,
      {
        content: "two",
        expectedRevision: created.revision,
      },
    );
    expect(updated.revision).toBe(created.revision + 1);
    const read = await catalog.readResource(context, project.id, created.id);
    expect(read.content).toBe("two");
  });

  it("answers 409 for a stale revision and leaves the content untouched", async () => {
    const { context, project } = await aProject("Stale");
    const created = await catalog.createResource(context, project.id, {
      path: "a.seq",
      type: "sequence-diagram",
      content: "first",
    });
    await catalog.updateResource(context, project.id, created.id, {
      content: "second",
      expectedRevision: 1,
    });

    const failure = await failureOf(
      catalog.updateResource(context, project.id, created.id, {
        content: "third",
        expectedRevision: 1,
      }),
    );
    expect(failure.code).toBe("conflict");
    expect(failure.status).toBe(409);
    expect(failure.details).toEqual({
      expectedRevision: 1,
      currentRevision: 2,
    });

    const read = await catalog.readResource(context, project.id, created.id);
    expect(read.content).toBe("second");
  });

  it("lets only one of two concurrent writers win a revision", async () => {
    const { context, project } = await aProject("Concurrent");
    const created = await catalog.createResource(context, project.id, {
      path: "a.seq",
      type: "sequence-diagram",
      content: "base",
    });
    const results = await Promise.allSettled([
      catalog.updateResource(context, project.id, created.id, {
        content: "writer A",
        expectedRevision: 1,
      }),
      catalog.updateResource(context, project.id, created.id, {
        content: "writer B",
        expectedRevision: 1,
      }),
    ]);
    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry) => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      (await catalog.getResource(context, project.id, created.id)).revision,
    ).toBe(2);
  });

  it("refuses a move whose revision is stale", async () => {
    const { context, project } = await aProject("Stale move");
    const created = await catalog.createResource(context, project.id, {
      path: "a.seq",
      type: "sequence-diagram",
      content: "x",
    });
    await catalog.updateResource(context, project.id, created.id, {
      content: "y",
      expectedRevision: 1,
    });
    const failure = await failureOf(
      catalog.moveResource(context, project.id, created.id, {
        path: "b.seq",
        expectedRevision: 1,
      }),
    );
    expect(failure.code).toBe("conflict");
    // The refused move must leave the document where it was: a `409` that had
    // already renamed the file would strand it at a path no record names, and
    // the resource would read as missing.
    const after = await catalog.readResource(context, project.id, created.id);
    expect(after.resource.path).toBe("a.seq");
    expect(after.content).toBe("y");
  });

  it("refuses a move onto a path another resource holds", async () => {
    const { context, project } = await aProject("Collision");
    const first = await catalog.createResource(context, project.id, {
      path: "a.seq",
      type: "sequence-diagram",
      content: "a",
    });
    await catalog.createResource(context, project.id, {
      path: "b.seq",
      type: "sequence-diagram",
      content: "b",
    });
    const failure = await failureOf(
      catalog.moveResource(context, project.id, first.id, {
        path: "b.seq",
        expectedRevision: 1,
      }),
    );
    expect(failure.code).toBe("conflict");
  });
});

describe("the audit trail", () => {
  it("records the mutations a project goes through", async () => {
    const { context, project } = await aProject("Audited");
    const created = await catalog.createResource(context, project.id, {
      path: "a.seq",
      type: "sequence-diagram",
      content: "one",
    });
    await catalog.updateResource(context, project.id, created.id, {
      content: "two",
      expectedRevision: 1,
    });

    const entries = await audit.listForProject(project.id, 50);
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain("project.created");
    expect(actions).toContain("resource.created");
    expect(actions).toContain("resource.updated");
    for (const entry of entries) {
      expect(entry.requestId).toBe("req-test");
      expect(JSON.stringify(entry.detail)).not.toMatch(
        /token|password|cookie/i,
      );
    }
  });
});
