/**
 * PostgreSQL + volume atomicity (mission item 16).
 *
 * A project's resource *identity* lives in PostgreSQL and its resource *content*
 * lives on a volume, and no transaction spans the two. That is a deliberate
 * boundary, not an oversight — but it means every mutation can fail *between* its
 * two writes, and the interesting question is what state it leaves behind.
 *
 * These tests inject a failure into one side at a time and assert the resulting
 * state is the one documented in `docs/plan/server-migration-4.md`:
 *
 * ```text
 * operation   first step        second step       state after failure
 * create      volume write      row insert        file only (orphan), no row
 * update      revision bump     volume write      revision consumed, content old
 * move        volume move       row move          file moved back, row unchanged
 * delete      volume remove     row delete        file gone, row remains
 * ```
 *
 * "Recoverable" here means *the database never claims something the volume does
 * not have, and the volume never holds a document the database cannot explain*
 * — with the one documented exception, a create whose row insert fails, which
 * leaves the bytes behind for an operator to reconcile. A full fix is a
 * compensation pass or an outbox; that is out of scope for Phase 4 and is
 * recorded as such rather than hidden.
 */
// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createProjectCatalog } from "../../src/application/project-catalog";
import { createFsProjectStorage } from "../../src/persistence/fs-project-storage";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createAuditRepository } from "../../src/persistence/audit-repository";
import type { ProjectStorage } from "../../src/application/project-storage";
import type { ApplicationContext } from "../../src/application/context";
import { ApplicationError } from "../../src/application/errors";
import {
  ALL_PERMISSIONS,
  type Permission,
} from "../../src/domain/access/permissions";
import type { SqlClient } from "../../src/persistence/sql-client";
import { openTestDatabase, closeTestDatabase } from "./test-database";
import type { ProjectRepository } from "../../src/application/ports/project-repository";

let client: SqlClient;
let volume: string;

beforeAll(async () => {
  client = await openTestDatabase();
  volume = await mkdtemp(path.join(tmpdir(), "sd-atomicity-"));
});

afterAll(async () => {
  await closeTestDatabase(client);
  await rm(volume, { recursive: true, force: true });
});

/** Which side of a mutation should fail in this test. */
interface Faults {
  /** Make the volume's `write` fail. */
  volumeWrite?: boolean;
  /** Make the volume's `remove` fail. */
  volumeRemove?: boolean;
  /** Make the volume's `move` fail. */
  volumeMove?: boolean;
  /** Make the repository's `createResource` fail after the volume write. */
  rowCreate?: boolean;
  /** Make the repository's `moveResource` refuse as stale after the volume move. */
  rowMove?: boolean;
  /** Make the repository's `moveResource` *throw* after the volume move. */
  rowMoveThrows?: boolean;
  /** Make the repository's `deleteResource` fail after the volume remove. */
  rowDelete?: boolean;
}

const ALL_SCOPES: Permission[] = [...ALL_PERMISSIONS];

/** The failure every injected fault reports. */
function injected(what: string): Error {
  return new Error(`injected ${what} failure`);
}

/** A storage that delegates to the real one and can fail one operation. */
function faultyStorage(inner: ProjectStorage, faults: Faults): ProjectStorage {
  return {
    root: inner.root,
    list: () => inner.list(),
    read: (path) => inner.read(path),
    exists: (path) => inner.exists(path),
    write: (path, content) =>
      faults.volumeWrite
        ? Promise.resolve({ ok: false, error: injected("volume write") })
        : inner.write(path, content),
    remove: (path) =>
      faults.volumeRemove
        ? Promise.resolve({ ok: false, error: injected("volume remove") })
        : inner.remove(path),
    move: (move) =>
      faults.volumeMove
        ? Promise.resolve({ ok: false, error: injected("volume move") })
        : inner.move(move),
  };
}

/** A repository that delegates to the real one and can fail one write. */
function faultyRepository(
  inner: ProjectRepository,
  faults: Faults,
): ProjectRepository {
  return {
    ...inner,
    createResource: (projectId, resource) =>
      faults.rowCreate
        ? Promise.reject(injected("resource row insert"))
        : inner.createResource(projectId, resource),
    moveResource: (projectId, resourceId, newPath, expectedRevision) => {
      if (faults.rowMoveThrows) {
        return Promise.reject(injected("resource row move"));
      }
      if (faults.rowMove) {
        // The realistic refusal: the conditional update found another writer.
        return Promise.resolve({
          ok: false,
          error: {
            expectedRevision,
            currentRevision: expectedRevision + 1,
          },
        });
      }
      return inner.moveResource(
        projectId,
        resourceId,
        newPath,
        expectedRevision,
      );
    },
    deleteResource: (projectId, resourceId) =>
      faults.rowDelete
        ? Promise.reject(injected("resource row delete"))
        : inner.deleteResource(projectId, resourceId),
  };
}

/**
 * A catalog over the real database and volume, with the faults armed.
 *
 * The factory is consulted per call, so a test can flip a fault between two
 * operations — which is how "the volume write failed but the row insert would
 * have succeeded" is expressed.
 */
async function build(faults: Faults) {
  const users = createUserRepository(client);
  const projects = faultyRepository(createProjectRepository(client), faults);
  const audit = createAuditRepository(client);
  const catalog = createProjectCatalog({
    projects,
    audit,
    storage: (projectId) =>
      faultyStorage(
        createFsProjectStorage({ root: path.join(volume, projectId) }),
        faults,
      ),
  });
  const user = await users.findOrCreateByExternalIdentity({
    issuer: "https://idp.test",
    subject: `atomic-${Math.random().toString(36).slice(2)}`,
    displayName: "Atomic User",
    email: null,
  });
  const context: ApplicationContext = {
    requestId: "req-atomicity",
    principal: {
      subjectUserId: user.id,
      actor: { kind: "user", userId: user.id },
      authType: "session",
      scopes: ALL_SCOPES,
    },
  };
  const listing = await catalog.createProject(context, {
    name: `Atomic ${Math.random().toString(36).slice(2)}`,
  });
  return { catalog, context, projects, projectId: listing.project.id };
}

/** The `ApplicationError` a rejected call carries, for its code. */
async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "no-error";
  } catch (error) {
    return error instanceof ApplicationError ? error.code : "not-application";
  }
}

/** The content stored on the volume, or `null`. */
async function contentAt(projectId: string, file: string) {
  const store = createFsProjectStorage({ root: path.join(volume, projectId) });
  const read = await store.read(file);
  return read.ok ? (read.value?.content ?? null) : null;
}

afterEach(() => {
  // Faults are per-test objects, so there is nothing global to reset; this hook
  // documents that each `build(...)` starts from a clean slate.
});

describe("create", () => {
  it("leaves no row when the volume write fails", async () => {
    const { catalog, context, projects, projectId } = await build({
      volumeWrite: true,
    });

    expect(
      await codeOf(
        catalog.createResource(context, projectId, {
          path: "checkout.seq",
          type: "sequence-diagram",
          content: "title Checkout",
        }),
      ),
    ).toBe("invalid");

    // The database must not record a document whose bytes were never written.
    expect(await projects.listResources(projectId)).toEqual([]);
  });

  it("leaves the bytes behind when the row insert fails", async () => {
    const { catalog, context, projects, projectId } = await build({
      rowCreate: true,
    });

    await expect(
      catalog.createResource(context, projectId, {
        path: "orphan.seq",
        type: "sequence-diagram",
        content: "title Orphan",
      }),
    ).rejects.toBeTruthy();

    // The documented asymmetry: the volume holds a file the database cannot
    // explain. The operation failed loudly, and the state is reconcilable by an
    // operator (the bytes are the source of truth for content).
    expect(await projects.listResources(projectId)).toEqual([]);
    expect(await contentAt(projectId, "orphan.seq")).toBe("title Orphan");
  });
});

describe("update", () => {
  it("consumes the revision when the volume write fails, leaving content unchanged", async () => {
    const faults: Faults = {};
    const { catalog, context, projects, projectId } = await build(faults);
    const created = await catalog.createResource(context, projectId, {
      path: "checkout.seq",
      type: "sequence-diagram",
      content: "title Checkout",
    });
    expect(created.revision).toBe(1);

    faults.volumeWrite = true;
    expect(
      await codeOf(
        catalog.updateResource(context, projectId, created.id, {
          content: "title Changed",
          expectedRevision: 1,
        }),
      ),
    ).toBe("invalid");

    // This is deliberate (mission item 17): the revision is claimed before the
    // bytes are written, so a stale writer can never touch the file. The cost is
    // that a failed write still consumes a revision — which is why clients must
    // treat the revision as opaque monotonic state, never as a write counter.
    const record = await projects.findResource(projectId, created.id);
    expect(record?.revision).toBe(2);
    expect(await contentAt(projectId, "checkout.seq")).toBe("title Checkout");
    // The old revision is now stale, so a blind retry is refused rather than
    // silently applied twice.
    expect(
      await codeOf(
        catalog.updateResource(context, projectId, created.id, {
          content: "title Retry",
          expectedRevision: 1,
        }),
      ),
    ).toBe("conflict");
  });
});

describe("move", () => {
  it("changes nothing when the volume move fails", async () => {
    const faults: Faults = {};
    const { catalog, context, projects, projectId } = await build(faults);
    const created = await catalog.createResource(context, projectId, {
      path: "checkout.seq",
      type: "sequence-diagram",
      content: "title Checkout",
    });

    faults.volumeMove = true;
    expect(
      await codeOf(
        catalog.moveResource(context, projectId, created.id, {
          path: "orders.seq",
          expectedRevision: created.revision,
        }),
      ),
    ).toBe("conflict");

    expect(await contentAt(projectId, "checkout.seq")).toBe("title Checkout");
    expect(await contentAt(projectId, "orders.seq")).toBeNull();
    const record = await projects.findResource(projectId, created.id);
    expect(record?.path).toBe("checkout.seq");
    expect(record?.revision).toBe(created.revision);
  });

  it("puts the file back when the row move fails", async () => {
    const faults: Faults = {};
    const { catalog, context, projects, projectId } = await build(faults);
    const created = await catalog.createResource(context, projectId, {
      path: "checkout.seq",
      type: "sequence-diagram",
      content: "title Checkout",
    });

    faults.rowMove = true;
    expect(
      await codeOf(
        catalog.moveResource(context, projectId, created.id, {
          path: "orders.seq",
          expectedRevision: created.revision,
        }),
      ),
    ).toBe("conflict");

    // The compensation ran: bytes and row are both back at the original path, so
    // the refused move left the project exactly as the caller found it.
    expect(await contentAt(projectId, "checkout.seq")).toBe("title Checkout");
    expect(await contentAt(projectId, "orders.seq")).toBeNull();
    const record = await projects.findResource(projectId, created.id);
    expect(record?.path).toBe("checkout.seq");
  });

  /**
   * The one case the compensation does *not* cover, recorded rather than hidden.
   *
   * The catalog only moves the file back when the repository *answers* that the
   * move was refused. If the database call itself throws — the connection drops
   * between the volume move and the row update — there is no answer to react to,
   * and the bytes stay at the new path while the row still names the old one. A
   * reader then gets a `not_found` that says the file is missing, which is
   * recoverable (the bytes exist, and the row is the authority to repair) but not
   * automatic. Closing it properly needs the outbox/compensation pass that
   * Phase 6 owns; what matters now is that the failure is loud and the state is
   * explainable.
   */
  it("leaves a stranded file when the row move throws outright", async () => {
    const faults: Faults = {};
    const { catalog, context, projects, projectId } = await build(faults);
    const created = await catalog.createResource(context, projectId, {
      path: "checkout.seq",
      type: "sequence-diagram",
      content: "title Checkout",
    });

    faults.rowMoveThrows = true;
    await expect(
      catalog.moveResource(context, projectId, created.id, {
        path: "orders.seq",
        expectedRevision: created.revision,
      }),
    ).rejects.toThrow(/injected resource row move/);

    // The volume moved; the row did not; the read reports the mismatch plainly.
    expect(await contentAt(projectId, "orders.seq")).toBe("title Checkout");
    expect(await contentAt(projectId, "checkout.seq")).toBeNull();
    const record = await projects.findResource(projectId, created.id);
    expect(record?.path).toBe("checkout.seq");
    expect(
      await codeOf(catalog.readResource(context, projectId, created.id)),
    ).toBe("not_found");
  });
});

describe("delete", () => {
  it("keeps the row when the volume remove fails", async () => {
    const faults: Faults = {};
    const { catalog, context, projects, projectId } = await build(faults);
    const created = await catalog.createResource(context, projectId, {
      path: "checkout.seq",
      type: "sequence-diagram",
      content: "title Checkout",
    });

    faults.volumeRemove = true;
    await expect(
      catalog.deleteResource(context, projectId, created.id),
    ).rejects.toBeTruthy();

    expect(await projects.findResource(projectId, created.id)).not.toBeNull();
    expect(await contentAt(projectId, "checkout.seq")).toBe("title Checkout");
  });

  it("reports a missing file rather than pretending when the row delete fails", async () => {
    const faults: Faults = {};
    const { catalog, context, projects, projectId } = await build(faults);
    const created = await catalog.createResource(context, projectId, {
      path: "checkout.seq",
      type: "sequence-diagram",
      content: "title Checkout",
    });

    faults.rowDelete = true;
    await expect(
      catalog.deleteResource(context, projectId, created.id),
    ).rejects.toBeTruthy();

    // The bytes are gone but the row remains, so a read is a *not_found* that
    // says exactly what is wrong — rather than serving an empty document or a
    // 500. This is the recoverable state the design promises.
    expect(await contentAt(projectId, "checkout.seq")).toBeNull();
    expect(await projects.findResource(projectId, created.id)).not.toBeNull();
    expect(
      await codeOf(catalog.readResource(context, projectId, created.id)),
    ).toBe("not_found");
  });
});
