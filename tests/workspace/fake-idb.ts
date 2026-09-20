/**
 * An in-memory {@link IdbFactory} shared by the IndexedDB-backed store tests.
 *
 * It mirrors the pieces of IndexedDB the stores use: per-store async key/value
 * access, insertion order for {@link IdbObjectStore.getAll}, and `open` returning
 * a stable database per name so data survives across the per-operation
 * connections the repositories open. Keeping it here lets the workspace and
 * version-history tests drive real adapter code without a browser.
 */
import type {
  IdbDatabase,
  IdbFactory,
  IdbObjectStore,
  IdbTransaction,
} from "../../src/workspace/idb-adapter";

/** A single store backed by a Map plus an insertion-order key list. */
export class FakeObjectStore implements IdbObjectStore {
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

/** A database holding named {@link FakeObjectStore}s. */
export class FakeDatabase implements IdbDatabase {
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

/** A factory that hands out one persistent {@link FakeDatabase} per name. */
export class FakeFactory implements IdbFactory {
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
