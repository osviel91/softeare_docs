/**
 * A minimal, promise-based view of the pieces of IndexedDB the workspace needs.
 *
 * IndexedDB is callback-based and unavailable in jsdom, so the repository never
 * touches the real `indexedDB` global directly. Instead it depends on this tiny
 * interface, which models each object store as a `Map<key, value>` exposed
 * through four promise methods: {@link IdbObjectStore.get}, {@link
 * IdbObjectStore.getAll}, {@link IdbObjectStore.put}, and {@link
 * IdbObjectStore.delete}.
 *
 * Keeping the surface this small means the IndexedDB implementation is a thin
 * adapter, and tests can supply an in-memory fake without modeling the full
 * IndexedDB type system. The `IdbFactory.open` call performs the schema
 * upgrade (creating object stores) exactly once, mirroring real IndexedDB's
 * `onupgradeneeded`.
 */

/** A single object store, modeled as an async key/value map. */
export interface IdbObjectStore {
  /** Read one value by key, or `undefined` when absent. */
  get(key: string): Promise<unknown>;
  /** Read every value in the store, in insertion order. */
  getAll(): Promise<unknown[]>;
  /** Insert or replace the value for `value.id`; returns the stored key. */
  put(value: { id: string }): Promise<string>;
  /** Delete the entry for `key`; a no-op when the key is absent. */
  delete(key: string): Promise<void>;
}

/** Opens (and, on first use, upgrades) a database by name. */
export interface IdbFactory {
  /**
   * Open the named database, creating it and its object stores on first use.
   * `onupgradeneeded`-style schema creation happens here, so a fresh factory
   * starts empty and later opens adopt any existing schema.
   */
  open(
    name: string,
    onupgradeneeded?: (db: IdbDatabase) => void,
  ): Promise<IdbDatabase>;
}

/** An open database: runs read/write transactions against named stores. */
export interface IdbDatabase {
  /**
   * Begin a transaction over `storeNames` in the given `mode`. The caller must
   * await {@link IdbTransaction.done} before closing the database to ensure all
   * writes have flushed.
   */
  transaction(
    storeNames: string[],
    mode: "readonly" | "readwrite",
  ): IdbTransaction;
  /** Close the underlying connection. */
  close(): void;
}

/** A transaction granting access to the requested object stores. */
export interface IdbTransaction {
  /** Retrieve a handle to a named object store within this transaction. */
  objectStore(name: string): IdbObjectStore;
  /** Resolves once the transaction has committed (or rejects on error). */
  done: Promise<void>;
  /** Abort the transaction. Best-effort; a no-op once it has settled. */
  abort(): void;
}
