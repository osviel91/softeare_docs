/**
 * The server persistence layer (ADR-040).
 *
 * Everything here runs against a real PostgreSQL (PGlite), because the
 * guarantees being tested are database guarantees: a `WHERE revision = $n`
 * update that matches nothing is how a stale write is refused, and an
 * `ON CONFLICT` insert is how membership is upserted. A fake would only test the
 * fake.
 */
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createAuditRepository } from "../../src/persistence/audit-repository";
import type { SqlClient } from "../../src/persistence/sql-client";
import { isOk } from "../../src/shared/result/result";
import { openTestDatabase, closeTestDatabase, testUuid } from "./test-database";

let client: SqlClient;
let users: ReturnType<typeof createUserRepository>;
let projects: ReturnType<typeof createProjectRepository>;
let audit: ReturnType<typeof createAuditRepository>;

beforeAll(async () => {
  client = await openTestDatabase();
  users = createUserRepository(client, {
    newId: () => testUuid(Math.floor(Math.random() * 1_000_000) + 1_000_000),
  });
  projects = createProjectRepository(client, {
    newId: () => testUuid(Math.floor(Math.random() * 1_000_000) + 2_000_000),
  });
  audit = createAuditRepository(client);
});

afterAll(async () => {
  await closeTestDatabase(client);
});

/** A fresh user for a test. */
async function aUser(displayName = "Ada Lovelace") {
  return users.findOrCreateByExternalIdentity({
    issuer: "https://idp.test",
    subject: `subject-${Math.random().toString(36).slice(2)}`,
    displayName,
    email: "ada@example.test",
  });
}

describe("user repository", () => {
  it("creates a user on first sight and finds it by identity afterwards", async () => {
    const identity = {
      issuer: "https://idp.test",
      subject: "stable-subject",
      displayName: "Grace Hopper",
      email: "grace@example.test",
    };
    const created = await users.findOrCreateByExternalIdentity(identity);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await users.findByIdentity("https://idp.test", "stable-subject"),
    ).toMatchObject({
      id: created.id,
    });

    const again = await users.findOrCreateByExternalIdentity(identity);
    expect(again.id).toBe(created.id);

    const byId = await users.findById(created.id);
    expect(byId?.displayName).toBe("Grace Hopper");
  });

  it("maps the same subject at a different issuer to a different user", async () => {
    const first = await users.findOrCreateByExternalIdentity({
      issuer: "https://a.test",
      subject: "shared-subject",
      displayName: "A",
      email: null,
    });
    const second = await users.findOrCreateByExternalIdentity({
      issuer: "https://b.test",
      subject: "shared-subject",
      displayName: "B",
      email: null,
    });
    expect(first.id).not.toBe(second.id);
  });

  it("refreshes the display name and email on a later login", async () => {
    const identity = {
      issuer: "https://idp.test",
      subject: "renamed-subject",
      displayName: "Old Name",
      email: "old@example.test",
    };
    const created = await users.findOrCreateByExternalIdentity(identity);
    const renamed = await users.findOrCreateByExternalIdentity({
      ...identity,
      displayName: "New Name",
      email: "new@example.test",
    });
    expect(renamed.id).toBe(created.id);
    expect(renamed.displayName).toBe("New Name");
    expect(renamed.email).toBe("new@example.test");
  });

  it("never uses email as the identity key", async () => {
    const first = await users.findOrCreateByExternalIdentity({
      issuer: "https://idp.test",
      subject: "one",
      displayName: "One",
      email: "shared@example.test",
    });
    const second = await users.findOrCreateByExternalIdentity({
      issuer: "https://idp.test",
      subject: "two",
      displayName: "Two",
      email: "shared@example.test",
    });
    expect(second.id).not.toBe(first.id);
  });

  it("answers null for an unknown id or identity", async () => {
    expect(await users.findById(testUuid(999999))).toBeNull();
    expect(await users.findByIdentity("https://idp.test", "nobody")).toBeNull();
  });

  it("creates and finds a local credential without an external identity", async () => {
    const created = await users.createLocalAccount({
      email: "ada@example.test",
      displayName: "Ada",
      passwordSalt: "salt",
      passwordHash: "hash",
    });
    const login = await users.findLocalByEmail("ada@example.test");

    expect(login).toMatchObject({
      user: { id: created.id, status: "PENDING" },
      passwordSalt: "salt",
      passwordHash: "hash",
    });
    expect(await users.findByIdentity("local", "ada@example.test")).toBeNull();
    await expect(
      users.createLocalAccount({
        email: "ada@example.test",
        displayName: "Ada Again",
        passwordSalt: "salt",
        passwordHash: "hash",
      }),
    ).rejects.toThrow();
  });

  it("records activation metadata", async () => {
    const admin = await aUser("Admin");
    const user = await users.createLocalAccount({
      email: `pending-${Math.random()}@example.test`,
      displayName: "Pending",
      passwordSalt: "salt",
      passwordHash: "hash",
    });

    const activated = await users.setStatus(user.id, "ACTIVE", admin.id);
    expect(activated.activatedAt).toBeInstanceOf(Date);
    expect(activated.activatedBy).toBe(admin.id);
  });
});

describe("project repository", () => {
  it("creates a project and makes the creator its OWNER", async () => {
    const owner = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Payments Platform",
    });

    expect(project.slug).toBe("payments-platform");
    expect(await projects.roleOf(project.id, owner.id)).toBe("OWNER");

    const listing = await projects.listForUser(owner.id);
    expect(listing.map((entry) => entry.project.id)).toContain(project.id);
    expect(listing.find((entry) => entry.project.id === project.id)?.role).toBe(
      "OWNER",
    );
  });

  it("gives two projects with the same name distinct slugs for one owner", async () => {
    const owner = await aUser();
    const first = await projects.create({ ownerId: owner.id, name: "OSIRIS" });
    const second = await projects.create({ ownerId: owner.id, name: "OSIRIS" });
    expect(first.slug).toBe("osiris");
    expect(second.slug).toBe("osiris-2");
  });

  it("falls back to a usable slug when a name has no ASCII word", async () => {
    const owner = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "設計文書",
    });
    expect(project.slug).toBe("project");
  });

  it("refuses an empty name", async () => {
    const owner = await aUser();
    await expect(
      projects.create({ ownerId: owner.id, name: "   " }),
    ).rejects.toThrow(/name is required/);
  });

  it("lists only the projects a user belongs to", async () => {
    const owner = await aUser();
    const stranger = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Private",
    });

    expect(
      (await projects.listForUser(stranger.id)).map((e) => e.project.id),
    ).not.toContain(project.id);
    expect(await projects.roleOf(project.id, stranger.id)).toBeNull();
  });

  it("shares a project with a member and reflects the change", async () => {
    const owner = await aUser();
    const viewer = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Shared",
    });

    expect(
      (await projects.listForUser(viewer.id)).map((e) => e.project.id),
    ).not.toContain(project.id);
    await projects.setMember(project.id, viewer.id, "VIEWER");
    const listing = await projects.listForUser(viewer.id);
    expect(listing.find((entry) => entry.project.id === project.id)?.role).toBe(
      "VIEWER",
    );
    expect(await projects.roleOf(project.id, viewer.id)).toBe("VIEWER");
  });

  it("changes a member's role rather than duplicating the membership", async () => {
    const owner = await aUser();
    const member = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Promote me",
    });

    await projects.setMember(project.id, member.id, "VIEWER");
    await projects.setMember(project.id, member.id, "EDITOR");
    const members = await projects.listMembers(project.id);
    expect(members.filter((entry) => entry.userId === member.id)).toHaveLength(
      1,
    );
    expect(await projects.roleOf(project.id, member.id)).toBe("EDITOR");
  });

  it("lists members owners-first", async () => {
    const owner = await aUser();
    const editor = await aUser();
    const viewer = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Ordered",
    });
    await projects.setMember(project.id, viewer.id, "VIEWER");
    await projects.setMember(project.id, editor.id, "EDITOR");
    const roles = (await projects.listMembers(project.id)).map((m) => m.role);
    expect(roles).toEqual(["OWNER", "EDITOR", "VIEWER"]);
  });

  it("removes a member", async () => {
    const owner = await aUser();
    const member = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Temporary",
    });
    await projects.setMember(project.id, member.id, "VIEWER");
    await projects.removeMember(project.id, member.id);
    expect(await projects.roleOf(project.id, member.id)).toBeNull();
  });

  it("renames a project and keeps its id", async () => {
    const owner = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Before",
    });
    const renamed = await projects.update(project.id, { name: "After" });
    expect(renamed.id).toBe(project.id);
    expect(renamed.name).toBe("After");
    expect(renamed.updatedAt.getTime()).toBeGreaterThanOrEqual(
      project.createdAt.getTime(),
    );
  });

  it("deletes a project and its membership rows", async () => {
    const owner = await aUser();
    const member = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Doomed",
    });
    await projects.setMember(project.id, member.id, "EDITOR");
    await projects.delete(project.id);
    expect(await projects.findById(project.id)).toBeNull();
    expect(await projects.roleOf(project.id, member.id)).toBeNull();
    expect(await projects.listMembers(project.id)).toEqual([]);
  });

  it("counts a project's resources without reading its files", async () => {
    const owner = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Counted",
    });
    await projects.createResource(project.id, {
      path: "diagrams/a.seq",
      type: "sequence-diagram",
    });
    await projects.createResource(project.id, {
      path: "docs/b.md",
      type: "markdown-document",
    });
    const listing = await projects.listForUser(owner.id);
    expect(
      listing.find((entry) => entry.project.id === project.id)?.resourceCount,
    ).toBe(2);
  });
});

describe("resource records and optimistic concurrency", () => {
  it("records a resource at revision 1 and validates its path on the way in", async () => {
    const owner = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Resources",
    });
    const resource = await projects.createResource(project.id, {
      path: "diagrams/checkout.seq",
      type: "sequence-diagram",
    });
    expect(resource.revision).toBe(1);
    expect(resource.path).toBe("diagrams/checkout.seq");
    await expect(
      projects.createResource(project.id, {
        path: "../escape.seq",
        type: "sequence-diagram",
      }),
    ).rejects.toThrow(/Invalid resource path/);
  });

  it("finds a resource by id and by path, scoped to the project", async () => {
    const owner = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Lookup",
    });
    const resource = await projects.createResource(project.id, {
      path: "a.seq",
      type: "sequence-diagram",
    });
    expect((await projects.findResource(project.id, resource.id))?.path).toBe(
      "a.seq",
    );
    expect((await projects.findResourceByPath(project.id, "a.seq"))?.id).toBe(
      resource.id,
    );

    const other = await projects.create({ ownerId: owner.id, name: "Other" });
    expect(await projects.findResource(other.id, resource.id)).toBeNull();
    expect(await projects.findResourceByPath(other.id, "a.seq")).toBeNull();
  });

  it("bumps a revision when the caller saw the current one", async () => {
    const owner = await aUser();
    const project = await projects.create({ ownerId: owner.id, name: "Bump" });
    const resource = await projects.createResource(project.id, {
      path: "a.seq",
      type: "sequence-diagram",
    });
    const bumped = await projects.bumpRevision(project.id, resource.id, 1);
    expect(isOk(bumped)).toBe(true);
    expect(isOk(bumped) && bumped.value.revision).toBe(2);
  });

  it("reports a mismatch with the current revision when the caller is stale", async () => {
    const owner = await aUser();
    const project = await projects.create({ ownerId: owner.id, name: "Stale" });
    const resource = await projects.createResource(project.id, {
      path: "a.seq",
      type: "sequence-diagram",
    });
    await projects.bumpRevision(project.id, resource.id, 1);

    const stale = await projects.bumpRevision(project.id, resource.id, 1);
    expect(isOk(stale)).toBe(false);
    expect(!isOk(stale) && stale.error).toEqual({
      expectedRevision: 1,
      currentRevision: 2,
    });

    const fresh = await projects.bumpRevision(project.id, resource.id, 2);
    expect(isOk(fresh) && fresh.value.revision).toBe(3);
  });

  it("never lets two writers both win the same revision", async () => {
    const owner = await aUser();
    const project = await projects.create({ ownerId: owner.id, name: "Race" });
    const resource = await projects.createResource(project.id, {
      path: "a.seq",
      type: "sequence-diagram",
    });

    const [first, second] = await Promise.all([
      projects.bumpRevision(project.id, resource.id, 1),
      projects.bumpRevision(project.id, resource.id, 1),
    ]);
    const winners = [first, second].filter(isOk);
    expect(winners).toHaveLength(1);
    expect(
      (await projects.findResource(project.id, resource.id))?.revision,
    ).toBe(2);
  });

  it("reports a missing resource as a mismatch with revision 0", async () => {
    const owner = await aUser();
    const project = await projects.create({ ownerId: owner.id, name: "Gone" });
    const missing = await projects.bumpRevision(
      project.id,
      testUuid(424242),
      1,
    );
    expect(!isOk(missing) && missing.error.currentRevision).toBe(0);
  });

  it("moves a resource, bumping its revision and keeping its id", async () => {
    const owner = await aUser();
    const project = await projects.create({ ownerId: owner.id, name: "Move" });
    const resource = await projects.createResource(project.id, {
      path: "old.seq",
      type: "sequence-diagram",
    });
    const moved = await projects.moveResource(
      project.id,
      resource.id,
      "diagrams/new.seq",
      1,
    );
    expect(isOk(moved)).toBe(true);
    expect(isOk(moved) && moved.value.path).toBe("diagrams/new.seq");
    expect(isOk(moved) && moved.value.revision).toBe(2);
    expect(isOk(moved) && moved.value.id).toBe(resource.id);
  });

  it("refuses a move to a path another resource already holds", async () => {
    const owner = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Collide",
    });
    const first = await projects.createResource(project.id, {
      path: "a.seq",
      type: "sequence-diagram",
    });
    await projects.createResource(project.id, {
      path: "b.seq",
      type: "sequence-diagram",
    });
    await expect(
      projects.moveResource(project.id, first.id, "b.seq", 1),
    ).rejects.toThrow();
  });

  it("forgets a resource", async () => {
    const owner = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Forget",
    });
    const resource = await projects.createResource(project.id, {
      path: "a.seq",
      type: "sequence-diagram",
    });
    await projects.deleteResource(project.id, resource.id);
    expect(await projects.findResource(project.id, resource.id)).toBeNull();
  });
});

describe("audit repository", () => {
  it("records an entry with its actor, action and correlation id", async () => {
    const owner = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Audited",
    });
    const entry = await audit.record({
      action: "project.created",
      subjectUserId: owner.id,
      authType: "session",
      projectId: project.id,
      requestId: "req-1",
      detail: { name: project.name },
    });
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.occurredAt).toBeInstanceOf(Date);

    const listed = await audit.listForProject(project.id);
    expect(listed.map((row) => row.action)).toEqual(["project.created"]);
    expect(listed[0].detail).toEqual({ name: project.name });
  });

  it("records several entries atomically and in order", async () => {
    const owner = await aUser();
    const project = await projects.create({ ownerId: owner.id, name: "Batch" });
    const written = await audit.recordAll([
      {
        action: "resource.created",
        subjectUserId: owner.id,
        authType: "pat",
        projectId: project.id,
      },
      {
        action: "resource.updated",
        subjectUserId: owner.id,
        authType: "pat",
        projectId: project.id,
      },
    ]);
    expect(written.map((row) => row.action)).toEqual([
      "resource.created",
      "resource.updated",
    ]);
  });

  it("lists a user's actions across projects, newest first", async () => {
    const owner = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "History",
    });
    await audit.record({
      action: "project.created",
      subjectUserId: owner.id,
      authType: "session",
      projectId: project.id,
    });
    await audit.record({
      action: "resource.created",
      subjectUserId: owner.id,
      authType: "session",
      projectId: project.id,
    });
    const listed = await audit.listForUser(owner.id);
    expect(listed[0].action).toBe("resource.created");
    expect(listed[1].action).toBe("project.created");
  });

  it("keeps an audit row when its user is deleted, without the user id", async () => {
    const owner = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Survivor",
    });
    await audit.record({
      action: "project.created",
      subjectUserId: owner.id,
      authType: "session",
      projectId: project.id,
    });
    await client.query("DELETE FROM users WHERE id = $1", [owner.id]);
    const listed = await audit.listForProject(project.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].subjectUserId).toBeNull();
  });

  it("bounds a listing", async () => {
    const owner = await aUser();
    const project = await projects.create({
      ownerId: owner.id,
      name: "Bounded",
    });
    for (let index = 0; index < 5; index += 1) {
      await audit.record({
        action: "mcp.tool.executed",
        subjectUserId: owner.id,
        authType: "pat",
        projectId: project.id,
        detail: { tool: `tool_${index}` },
      });
    }
    expect(await audit.listForProject(project.id, 2)).toHaveLength(2);
  });
});
