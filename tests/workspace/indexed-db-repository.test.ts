import { beforeEach, describe, expect, it } from "vitest";
import type { DiagramFile } from "../../src/domain/workspace/types";
import { testWorkspaceIdFactory } from "../../src/domain/workspace/workspace-ids";
import { isOk } from "../../src/shared/result/result";
import type {
  IdbDatabase,
  IdbFactory,
  IdbObjectStore,
  IdbTransaction,
} from "../../src/workspace/idb-adapter";
import { createIndexedDbRepository } from "../../src/workspace/indexed-db";
import type { WorkspaceRepository } from "../../src/workspace/WorkspaceRepository";

/**
 * An in-memory {@link IdbFactory} backed by plain Maps. It mirrors the pieces of
 * IndexedDB the repository uses: per-store async key/value access, insertion
 * order for {@link IdbObjectStore.getAll}, and `open` returning a stable database
 * per name so data survives across the repository's per-operation connections.
 */
class FakeObjectStore implements IdbObjectStore {
  private values = new Map<string, unknown>();
  private order: string[] = [];

  async get(key: string): Promise<unknown> {
    return this.values.has(key) ? this.values.get(key) : undefined;
  }

  async getAll(): Promise<unknown[]> {
    return this.order.map((key) => this.values.get(key));
  }

  async put(value: { id: string }): Promise<string> {
    if (!this.values.has(value.id)) {
      this.order.push(value.id);
    }
    this.values.set(value.id, value);
    return value.id;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.order = this.order.filter((existing) => existing !== key);
  }
}

class FakeDatabase implements IdbDatabase {
  private stores = new Map<string, FakeObjectStore>();

  transaction(storeNames: string[]): IdbTransaction {
    // Each named store is independent, so a transaction over several names (as
    // deleteProject and saveDiagramFile do) touches distinct backing maps. The
    // objectStore handle resolves to the backing store for the requested name,
    // so a write to one store never falls through to another.
    const backing = new Map<string, FakeObjectStore>();
    for (const name of storeNames) {
      backing.set(name, this.storeFor(name));
    }
    return {
      objectStore: (name) => backing.get(name) ?? new FakeObjectStore(),
      done: Promise.resolve(),
      abort: () => {
        /* nothing to abort in memory */
      },
    };
  }

  private storeFor(name: string): FakeObjectStore {
    let store = this.stores.get(name);
    if (!store) {
      store = new FakeObjectStore();
      this.stores.set(name, store);
    }
    return store;
  }

  close(): void {
    /* nothing to close in memory */
  }
}

class FakeFactory implements IdbFactory {
  private databases = new Map<string, FakeDatabase>();

  async open(name: string): Promise<IdbDatabase> {
    let db = this.databases.get(name);
    if (!db) {
      db = new FakeDatabase();
      this.databases.set(name, db);
    }
    return db;
  }
}

describe("IndexedDB workspace repository", () => {
  let repo: WorkspaceRepository;
  let ids: ReturnType<typeof testWorkspaceIdFactory>;

  beforeEach(() => {
    repo = createIndexedDbRepository(new FakeFactory());
    ids = testWorkspaceIdFactory();
  });

  it("starts empty", async () => {
    const result = await repo.listProjects();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual([]);
    }
  });

  it("creates a project with a fresh id and no diagrams", async () => {
    const result = await repo.createProject("Onboarding");
    if (!isOk(result)) throw result.error;
    const createdId = result.value.id;
    expect(result.value.name).toBe("Onboarding");
    expect(result.value.datasetIds).toEqual([]);

    const listed = await repo.listProjects();
    if (isOk(listed)) {
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0].id).toBe(createdId);
    }
  });

  it("returns null for an unknown project", async () => {
    const result = await repo.getProject("does-not-exist");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBeNull();
    }
  });

  it("stores a diagram and links it to the project", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;

    const diagram: DiagramFile = {
      id: ids.newDiagramFileId(),
      name: "Welcome",
      source: "title Welcome\nA -> B: hi",
      projectId,
    };
    const saved = await repo.saveDiagramFile(projectId, diagram);
    expect(isOk(saved)).toBe(true);

    const listed = await repo.listDiagramFiles(projectId);
    if (isOk(listed)) {
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0]).toEqual(diagram);
    }

    const fetched = await repo.getDiagramFile(projectId, diagram.id);
    if (isOk(fetched)) {
      expect(fetched.value).toEqual(diagram);
    }
  });

  it("enforces that a diagram belongs to exactly one project", async () => {
    const first = await repo.createProject("First");
    if (!isOk(first)) throw first.error;
    const second = await repo.createProject("Second");
    if (!isOk(second)) throw second.error;

    const diagram: DiagramFile = {
      id: ids.newDiagramFileId(),
      name: "Owned",
      source: "title Owned\nA -> B: hi",
      projectId: first.value.id,
    };
    await repo.saveDiagramFile(first.value.id, diagram);

    // Storing the same file under another project rewrites its projectId.
    const moved = await repo.saveDiagramFile(second.value.id, {
      ...diagram,
      projectId: second.value.id,
    });
    if (isOk(moved)) {
      expect(moved.value.projectId).toBe(second.value.id);
    }

    // The file no longer belongs to the original project.
    const fromFirst = await repo.getDiagramFile(first.value.id, diagram.id);
    expect(isOk(fromFirst)).toBe(true);
    if (isOk(fromFirst)) {
      expect(fromFirst.value).toBeNull();
    }
  });

  it("returns diagrams in insertion (display) order", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;

    const first = {
      id: ids.newDiagramFileId(),
      name: "A",
      source: "s1",
      projectId,
    };
    const second = {
      id: ids.newDiagramFileId(),
      name: "B",
      source: "s2",
      projectId,
    };
    const third = {
      id: ids.newDiagramFileId(),
      name: "C",
      source: "s3",
      projectId,
    };

    await repo.saveDiagramFile(projectId, first);
    await repo.saveDiagramFile(projectId, second);
    await repo.saveDiagramFile(projectId, third);

    const list = await repo.listDiagramFiles(projectId);
    if (isOk(list)) {
      expect(list.value.map((d) => d.id)).toEqual([
        first.id,
        second.id,
        third.id,
      ]);
    }
  });

  it("deletes a diagram and drops it from the project", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;
    const diagram: DiagramFile = {
      id: ids.newDiagramFileId(),
      name: "Welcome",
      source: "title Welcome\nA -> B: hi",
      projectId,
    };
    await repo.saveDiagramFile(projectId, diagram);

    const deleted = await repo.deleteDiagramFile(projectId, diagram.id);
    expect(isOk(deleted)).toBe(true);

    const listed = await repo.listDiagramFiles(projectId);
    if (isOk(listed)) {
      expect(listed.value).toEqual([]);
    }
  });

  it("deletes a project together with its diagrams (no orphans)", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;
    const diagram: DiagramFile = {
      id: ids.newDiagramFileId(),
      name: "Welcome",
      source: "title Welcome\nA -> B: hi",
      projectId,
    };
    await repo.saveDiagramFile(projectId, diagram);

    const deleted = await repo.deleteProject(projectId);
    expect(isOk(deleted)).toBe(true);

    const listed = await repo.listProjects();
    if (isOk(listed)) {
      expect(listed.value).toEqual([]);
    }

    // The diagram is gone, and a stale id resolves to null.
    const remaining = await repo.listAll();
    if (isOk(remaining)) {
      expect(remaining.value.diagrams).toEqual([]);
    }
    const fetched = await repo.getDiagramFile(projectId, diagram.id);
    expect(isOk(fetched)).toBe(true);
    if (isOk(fetched)) {
      expect(fetched.value).toBeNull();
    }
  });

  it("captures the whole workspace as a snapshot", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;
    const diagram: DiagramFile = {
      id: ids.newDiagramFileId(),
      name: "Welcome",
      source: "title Welcome\nA -> B: hi",
      projectId,
    };
    await repo.saveDiagramFile(projectId, diagram);

    const snapshot = await repo.listAll();
    expect(isOk(snapshot)).toBe(true);
    if (isOk(snapshot)) {
      expect(snapshot.value.projects).toHaveLength(1);
      expect(snapshot.value.diagrams).toHaveLength(1);
      expect(snapshot.value.diagrams[0].projectId).toBe(projectId);
    }
  });

  it("surfaces repository errors as a failed Result, not a throw", async () => {
    const rejectingFactory: IdbFactory = {
      open: () => Promise.reject(new Error("boom")),
    };
    const failingRepo = createIndexedDbRepository(rejectingFactory);
    const result = await failingRepo.listProjects();
    expect(isOk(result)).toBe(false);
    if (!isOk(result)) {
      expect(result.error.message).toContain("boom");
    }
  });
});
