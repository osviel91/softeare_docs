/**
 * Mutation reliability (Phase 6, mission items 27–32, 67–69).
 *
 * These tests are about the storage half of a project, which is the part that
 * cannot join a database transaction. They drive the real mutation service over
 * real PostgreSQL (PGlite) and a real volume, injecting a failure at each
 * boundary — the claim, the stage, the promote, the rename, the delete, the
 * finalize — and assert what the mission requires:
 *
 * - a stale writer can never overwrite a successful one;
 * - a failed write leaves the document as the caller found it;
 * - a failed move leaves *either* the old path or the new path valid, never an
 *   orphan invisible to both the database and the reader;
 * - an interrupted operation is finished by recovery;
 * - a retried mutation with the same idempotency key happens once.
 */
// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import { ApplicationError } from "../../src/application/errors";
import type { ApplicationContext } from "../../src/application/context";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createWorkspaceRepository } from "../../src/persistence/workspace-repository";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createFsProjectStorage } from "../../src/persistence/fs-project-storage";
import { createWorkspaceOperationRepository } from "../../src/persistence/workspace-operation-repository";
import { createProjectCatalog } from "../../src/application/project-catalog";
import {
  createWorkspaceMutationService,
  STAGING_DIRECTORY,
  type WorkspaceMutationService,
} from "../../src/application/workspace-mutations";
import { hashWorkspaceContent } from "../../src/persistence/server-runtime";
import type { ProjectStorage } from "../../src/application/project-storage";
import type { WorkspaceOperationRepository } from "../../src/application/ports/workspace-operation-repository";
import type { SqlClient } from "../../src/persistence/sql-client";
import { openTestDatabase, closeTestDatabase } from "./test-database";

let client: SqlClient;
let volume: string;
let users: ReturnType<typeof createUserRepository>;
let projects: ReturnType<typeof createProjectRepository>;
let operations: WorkspaceOperationRepository;
let mutations: WorkspaceMutationService;

beforeAll(async () => {
  client = await openTestDatabase();
  volume = await mkdtemp(path.join(tmpdir(), "sd-mutations-"));
  users = createUserRepository(client);
  projects = createProjectRepository(client);
  operations = createWorkspaceOperationRepository(client);
  mutations = createWorkspaceMutationService({
    projects,
    storage: (projectId) =>
      createFsProjectStorage({ root: path.join(volume, projectId) }),
    operations,
    hashContent: hashWorkspaceContent,
  });
});

afterAll(async () => {
  await closeTestDatabase(client);
  await rm(volume, { recursive: true, force: true });
});

/** A fresh user with full scopes, as a session would carry. */
async function aUser(): Promise<string> {
  const user = await users.findOrCreateByExternalIdentity({
    issuer: "https://idp.test",
    subject: `mut-${Math.random().toString(36).slice(2)}`,
    displayName: "Mutation User",
    email: null,
  });
  return user.id;
}

/** A context for a user. */
function contextFor(userId: string): ApplicationContext {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    principal: {
      subjectUserId: userId,
      actor: { kind: "user", userId },
      authType: "session",
      scopes: [...ALL_PERMISSIONS],
    },
  };
}

/** A project owned by a fresh user, with its storage directory created. */
async function aProject(): Promise<{
  projectId: string;
  context: ApplicationContext;
}> {
  const userId = await aUser();
  const context = contextFor(userId);
  const project = await projects.create({
    ownerId: userId,
    name: "Mutations",
  });
  await createFsProjectStorage({
    root: path.join(volume, project.id),
  }).list();
  return { projectId: project.id, context };
}

/** The stored text at a project-relative path, or `null`. */
async function contentAt(
  projectId: string,
  relative: string,
): Promise<string | null> {
  const read = await createFsProjectStorage({
    root: path.join(volume, projectId),
  }).read(relative);
  return read.ok && read.value !== null ? read.value.content : null;
}

/** Every file left in a project's staging directory. */
async function stagedFiles(projectId: string): Promise<string[]> {
  try {
    return await readdir(path.join(volume, projectId, STAGING_DIRECTORY));
  } catch {
    return [];
  }
}

/** Which storage step fails. */
interface StorageFaults {
  stage?: boolean;
  promote?: boolean;
  move?: boolean;
  remove?: boolean;
}

/** A store that fails exactly the named step. */
function faultyStorage(
  inner: ProjectStorage,
  faults: StorageFaults,
): ProjectStorage {
  return {
    root: inner.root,
    list: () => inner.list(),
    read: (p) => inner.read(p),
    exists: (p) => inner.exists(p),
    write: (p, content) =>
      faults.stage && p.startsWith(`${STAGING_DIRECTORY}/`)
        ? Promise.resolve({ ok: false, error: new Error("injected stage") })
        : inner.write(p, content),
    remove: (p) =>
      faults.remove
        ? Promise.resolve({ ok: false, error: new Error("injected remove") })
        : inner.remove(p),
    move: (move) =>
      faults.move
        ? Promise.resolve({ ok: false, error: new Error("injected move") })
        : inner.move(move),
    promote: (move) =>
      faults.promote
        ? Promise.resolve({ ok: false, error: new Error("injected promote") })
        : inner.promote(move),
  };
}

/** A mutation service whose storage fails the named step. */
function serviceWithFaults(faults: StorageFaults): WorkspaceMutationService {
  return createWorkspaceMutationService({
    projects,
    storage: (projectId) =>
      faultyStorage(
        createFsProjectStorage({ root: path.join(volume, projectId) }),
        faults,
      ),
    operations,
    hashContent: hashWorkspaceContent,
  });
}

/** Create a diagram through the real path. */
async function aDiagram(
  projectId: string,
  context: ApplicationContext,
  content = "title Checkout\n",
): Promise<string> {
  const resource = await mutations.createResource(context, projectId, {
    path: "checkout.seq",
    type: "sequence-diagram",
    content,
  });
  return resource.id;
}

describe("the lost-update window is closed", () => {
  it("refuses a stale write without touching the file", async () => {
    const { projectId, context } = await aProject();
    const id = await aDiagram(projectId, context);

    await mutations.updateResource(context, projectId, id, {
      content: "title First\n",
      expectedRevision: 1,
    });

    await expect(
      mutations.updateResource(context, projectId, id, {
        content: "title Loser\n",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    expect(await contentAt(projectId, "checkout.seq")).toBe("title First\n");
  });

  it("lets exactly one of two simultaneous writers win", async () => {
    const { projectId, context } = await aProject();
    const id = await aDiagram(projectId, context);

    const results = await Promise.allSettled([
      mutations.updateResource(context, projectId, id, {
        content: "title A\n",
        expectedRevision: 1,
      }),
      mutations.updateResource(context, projectId, id, {
        content: "title B\n",
        expectedRevision: 1,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const record = await projects.findResource(projectId, id);
    expect(record?.revision).toBe(2);

    // The bytes belong to the winner: the database revision and the document
    // agree, which is the whole point of claiming before writing.
    const stored = await contentAt(projectId, "checkout.seq");
    expect(["title A\n", "title B\n"]).toContain(stored);
  });

  it("refuses a writer while another operation is still unfinished", async () => {
    const { projectId, context } = await aProject();
    const id = await aDiagram(projectId, context);

    // Simulate an operation that claimed the resource and then stalled, with
    // its intended bytes durably staged but not yet promoted.
    const stalledId = "00000000-0000-7000-8000-000000000001";
    const store = createFsProjectStorage({
      root: path.join(volume, projectId),
    });
    await store.write(`${STAGING_DIRECTORY}/${stalledId}`, "title Stalled\n");
    await operations.claim({
      operationId: stalledId,
      projectId,
      resourceId: id,
      operation: "update",
      targetPath: "checkout.seq",
      stagedPath: `${STAGING_DIRECTORY}/${stalledId}`,
      contentHash: hashWorkspaceContent("title Stalled\n"),
      expectedRevision: 1,
      audit: {
        action: "resource.updated",
        subjectUserId: context.principal.subjectUserId,
        authType: "session",
        projectId,
        resourceId: id,
      },
    });

    await expect(
      mutations.updateResource(context, projectId, id, {
        content: "title Racer\n",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // Recovery finishes the stalled operation, and the resource is consistent.
    const report = await mutations.recover();
    expect(report.completed).toBe(1);
    expect(await contentAt(projectId, "checkout.seq")).toBe("title Stalled\n");
  });
});

describe("a failure leaves the document as the caller found it", () => {
  it("changes nothing at all when the staging write fails", async () => {
    const { projectId, context } = await aProject();
    const id = await aDiagram(projectId, context);
    const faulty = serviceWithFaults({ stage: true });

    await expect(
      faulty.updateResource(context, projectId, id, {
        content: "title Broken\n",
        expectedRevision: 1,
      }),
    ).rejects.toBeTruthy();

    expect(await contentAt(projectId, "checkout.seq")).toBe("title Checkout\n");
    expect((await projects.findResource(projectId, id))?.revision).toBe(1);
    expect(await stagedFiles(projectId)).toEqual([]);
  });

  it("consumes the revision but keeps the bytes when the promote fails", async () => {
    const { projectId, context } = await aProject();
    const id = await aDiagram(projectId, context);
    const faulty = serviceWithFaults({ promote: true });

    await expect(
      faulty.updateResource(context, projectId, id, {
        content: "title Broken\n",
        expectedRevision: 1,
      }),
    ).rejects.toBeTruthy();

    // The revision is a claim counter and is not reused; the document is intact.
    expect((await projects.findResource(projectId, id))?.revision).toBe(2);
    expect(await contentAt(projectId, "checkout.seq")).toBe("title Checkout\n");
    // The staged bytes must not survive a failed operation.
    expect(await stagedFiles(projectId)).toEqual([]);
  });

  it("restores the old path when a move's filesystem step fails", async () => {
    const { projectId, context } = await aProject();
    const id = await aDiagram(projectId, context);
    const faulty = serviceWithFaults({ move: true });

    await expect(
      faulty.moveResource(context, projectId, id, {
        path: "renamed.seq",
        expectedRevision: 1,
      }),
    ).rejects.toBeTruthy();

    // The mission's rule: never an invisible orphan. The row points at the old
    // path and the bytes are there.
    const record = await projects.findResource(projectId, id);
    expect(record?.path).toBe("checkout.seq");
    expect(await contentAt(projectId, "checkout.seq")).toBe("title Checkout\n");
    expect(await contentAt(projectId, "renamed.seq")).toBeNull();
  });

  it("keeps a move's new path valid when it succeeds", async () => {
    const { projectId, context } = await aProject();
    const id = await aDiagram(projectId, context);

    const moved = await mutations.moveResource(context, projectId, id, {
      path: "renamed.seq",
      expectedRevision: 1,
    });
    expect(moved.path).toBe("renamed.seq");
    expect(moved.revision).toBe(2);
    expect(await contentAt(projectId, "renamed.seq")).toBe("title Checkout\n");
    expect(await contentAt(projectId, "checkout.seq")).toBeNull();
  });

  it("removes the row but lets recovery clean up a failed delete", async () => {
    const { projectId, context } = await aProject();
    const id = await aDiagram(projectId, context);
    const faulty = serviceWithFaults({ remove: true });

    await expect(
      faulty.deleteResource(context, projectId, id),
    ).rejects.toBeTruthy();

    expect(await projects.findResource(projectId, id)).toBeNull();
    expect(await contentAt(projectId, "checkout.seq")).toBe("title Checkout\n");

    // Recovery removes the orphan the failed delete left behind.
    const report = await mutations.recover();
    expect(report.failed + report.completed).toBeGreaterThanOrEqual(1);
    expect(await contentAt(projectId, "checkout.seq")).toBeNull();
    expect(await operations.unfinished(100)).toEqual([]);
  });
});

describe("recovery finishes an interrupted operation", () => {
  it("completes a create whose bytes were staged but never promoted", async () => {
    const { projectId, context } = await aProject();
    const resourceId = "00000000-0000-7000-8000-0000000000aa";

    // The claim committed, then the process died before the promote.
    await operations.claim({
      operationId: "00000000-0000-7000-8000-0000000000ab",
      projectId,
      resourceId,
      operation: "create",
      targetPath: "recovered.seq",
      resourceType: "sequence-diagram",
      stagedPath: `${STAGING_DIRECTORY}/00000000-0000-7000-8000-0000000000ab`,
      contentHash: hashWorkspaceContent("title Recovered\n"),
      expectedRevision: null,
      audit: {
        action: "resource.created",
        subjectUserId: context.principal.subjectUserId,
        authType: "session",
        projectId,
        resourceId,
      },
    });
    await createFsProjectStorage({
      root: path.join(volume, projectId),
    }).write(
      `${STAGING_DIRECTORY}/00000000-0000-7000-8000-0000000000ab`,
      "title Recovered\n",
    );

    const report = await mutations.recover();
    expect(report.completed).toBe(1);
    expect(await contentAt(projectId, "recovered.seq")).toBe(
      "title Recovered\n",
    );
    expect(await stagedFiles(projectId)).toEqual([]);
  });

  it("completes a move whose file rename never ran", async () => {
    const { projectId, context } = await aProject();
    const id = await aDiagram(projectId, context);

    await operations.claim({
      operationId: "00000000-0000-7000-8000-0000000000ac",
      projectId,
      resourceId: id,
      operation: "move",
      sourcePath: "checkout.seq",
      targetPath: "later.seq",
      expectedRevision: 1,
      audit: {
        action: "resource.moved",
        subjectUserId: context.principal.subjectUserId,
        authType: "session",
        projectId,
        resourceId: id,
      },
    });

    const report = await mutations.recover();
    expect(report.completed).toBe(1);
    expect(await contentAt(projectId, "later.seq")).toBe("title Checkout\n");
    expect(await contentAt(projectId, "checkout.seq")).toBeNull();
    expect((await projects.findResource(projectId, id))?.path).toBe(
      "later.seq",
    );
  });
});

describe("idempotency", () => {
  it("performs a create once for a repeated key", async () => {
    const { projectId, context } = await aProject();
    const key = "agent-run-42";

    const first = await mutations.createResource(context, projectId, {
      path: "once.seq",
      type: "sequence-diagram",
      content: "title Once\n",
      idempotencyKey: key,
    });
    const second = await mutations.createResource(context, projectId, {
      path: "once.seq",
      type: "sequence-diagram",
      content: "title Once\n",
      idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);
    const records = await projects.listResources(projectId);
    expect(records.filter((r) => r.path === "once.seq")).toHaveLength(1);
  });

  it("performs an update once for a repeated key", async () => {
    const { projectId, context } = await aProject();
    const id = await aDiagram(projectId, context);
    const key = "agent-run-43";

    const first = await mutations.updateResource(context, projectId, id, {
      content: "title Once\n",
      expectedRevision: 1,
      idempotencyKey: key,
    });
    // A replay carries the *original* expectedRevision; without idempotency it
    // would be refused as stale, which is exactly what a retry must not do.
    const second = await mutations.updateResource(context, projectId, id, {
      content: "title Once\n",
      expectedRevision: 1,
      idempotencyKey: key,
    });

    expect(second.revision).toBe(first.revision);
    expect((await projects.findResource(projectId, id))?.revision).toBe(2);
  });

  it("scopes the key to the actor and project", async () => {
    const first = await aProject();
    const second = await aProject();
    const key = "shared-key";

    await mutations.createResource(first.context, first.projectId, {
      path: "shared.seq",
      type: "sequence-diagram",
      content: "title A\n",
      idempotencyKey: key,
    });
    // A different project with the same key is a different mutation.
    await mutations.createResource(second.context, second.projectId, {
      path: "shared.seq",
      type: "sequence-diagram",
      content: "title B\n",
      idempotencyKey: key,
    });

    expect(await contentAt(first.projectId, "shared.seq")).toBe("title A\n");
    expect(await contentAt(second.projectId, "shared.seq")).toBe("title B\n");
  });
});

describe("the journal is the authority", () => {
  it("records a completed operation and an audit row for every mutation", async () => {
    const { projectId, context } = await aProject();
    const id = await aDiagram(projectId, context);
    await mutations.updateResource(context, projectId, id, {
      content: "title Two\n",
      expectedRevision: 1,
    });

    const audit = await client.query(
      `SELECT action, actor_type, resource_id FROM audit_events
        WHERE project_id = $1 ORDER BY occurred_at ASC`,
      [projectId],
    );
    const actions = audit.rows.map((row) => String(row.action));
    expect(actions).toContain("resource.created");
    expect(actions).toContain("resource.updated");
    expect(audit.rows.every((row) => String(row.actor_type) === "user")).toBe(
      true,
    );

    const operationRows = await client.query(
      "SELECT status, operation FROM workspace_operations WHERE project_id = $1",
      [projectId],
    );
    expect(
      operationRows.rows.every((row) => String(row.status) === "completed"),
    ).toBe(true);
    // The journal never stores a document's contents.
    const stored = await client.query(
      "SELECT * FROM workspace_operations WHERE project_id = $1 LIMIT 1",
      [projectId],
    );
    expect(JSON.stringify(stored.rows[0])).not.toContain("title Checkout");
  });

  it("refuses a mutation when the deployment has no journal", async () => {
    expect(() =>
      createMutationServiceWithoutJournal().createResource(
        contextFor("00000000-0000-7000-8000-0000000000ff"),
        "00000000-0000-7000-8000-0000000000fe",
        { path: "x.seq", type: "sequence-diagram", content: "" },
      ),
    ).toThrow(ApplicationError);
  });
});

/** A service built with no journal, for the fail-closed assertion. */
function createMutationServiceWithoutJournal(): WorkspaceMutationService {
  // Reuses the real catalog's refusal, which is what a deployment would hit.
  const catalog = createProjectCatalog({
    projects,
    workspaces: createWorkspaceRepository(client),
    storage: (projectId) =>
      createFsProjectStorage({ root: path.join(volume, projectId) }),
  });
  return {
    createResource: (context, projectId, input) =>
      catalog.createResource(context, projectId, input),
    updateResource: (context, projectId, resourceId, input) =>
      catalog.updateResource(context, projectId, resourceId, input),
    moveResource: (context, projectId, resourceId, input) =>
      catalog.moveResource(context, projectId, resourceId, input),
    deleteResource: (context, projectId, resourceId, input) =>
      catalog.deleteResource(context, projectId, resourceId, input),
    recover: async () => ({ examined: 0, completed: 0, failed: 0, errors: [] }),
    purge: async () => ({ operations: 0, idempotency: 0 }),
  };
}

/** Read a file's bytes directly, proving the storage view is not lying. */
async function rawBytes(projectId: string, relative: string): Promise<string> {
  return readFile(path.join(volume, projectId, relative), "utf8");
}

describe("bytes on disk match what the API reported", () => {
  it("reads back exactly the content the mutation returned", async () => {
    const { projectId, context } = await aProject();
    const id = await aDiagram(projectId, context, "title Exact\n");
    expect(await rawBytes(projectId, "checkout.seq")).toBe("title Exact\n");
    await mutations.updateResource(context, projectId, id, {
      content: "title Changed\n",
      expectedRevision: 1,
    });
    expect(await rawBytes(projectId, "checkout.seq")).toBe("title Changed\n");
  });
});
