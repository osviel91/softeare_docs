/**
 * Hidden-path store: "remove from app, keep the file on disk".
 *
 * Deletion in the app has two scopes. The permanent one removes the entity from
 * its backing store (IndexedDB or the opened folder). The reversible one hides
 * it from the explorer without touching the file on disk, so an accidental
 * "delete" never destroys work the user only wanted out of the way.
 *
 * A local folder is read live from disk by {@link FileSystemWorkspaceRepository},
 * which is stateless and cacheless by design. The set of hidden paths therefore
 * lives outside the repository, in this small store, and the explorer filters
 * against it. Paths are the same stable ids the folder repository derives from
 * the tree (root-relative, `/`-separated), so a project is hidden by its own
 * path and every diagram under it is hidden by the prefix rule in
 * {@link isHidden}.
 *
 * The store is deliberately tiny and synchronous: it holds a set of strings, and
 * `localStorage` reads are fast enough that no async plumbing is warranted. The
 * interface exists so tests can inject an in-memory implementation and so a
 * future backend (say, IndexedDB) can replace the browser-storage one without
 * touching the UI.
 */

/** A set of workspace paths the user has removed from the app. */
export interface HiddenPathStore {
  /** Every hidden path. */
  list(): string[];
  /** Hide a path. Idempotent. */
  hide(path: string): void;
  /** Reveal a path again. Idempotent. */
  unhide(path: string): void;
  /** Forget every hidden path (used when the backing workspace is replaced). */
  clear(): void;
}

/** Normalize a workspace path: trim empty segments, rejoin with `/`. */
function normalize(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/");
}

/**
 * Whether `path` is hidden, either directly or because an ancestor directory was
 * hidden. Hiding a project therefore hides all of its diagrams.
 */
export function isHidden(hidden: ReadonlySet<string>, path: string): boolean {
  const normalized = normalize(path);
  if (normalized === "") return false;
  if (hidden.has(normalized)) return true;
  // Walk the ancestor chain: `a/b/c` is hidden when `a` or `a/b` is hidden.
  const segments = normalized.split("/");
  for (let i = 1; i < segments.length; i++) {
    if (hidden.has(segments.slice(0, i).join("/"))) return true;
  }
  return false;
}

/** An in-memory store; the fallback and the test double. */
export function createInMemoryHiddenPathStore(): HiddenPathStore {
  const hidden = new Set<string>();
  return {
    list: () => [...hidden],
    hide: (path) => {
      const normalized = normalize(path);
      if (normalized !== "") hidden.add(normalized);
    },
    unhide: (path) => {
      hidden.delete(normalize(path));
    },
    clear: () => hidden.clear(),
  };
}

/** The `localStorage` key holding one folder's hidden paths. */
export function hiddenPathsStorageKey(folderName: string): string {
  return `sequencediagrams.hidden.${folderName}`;
}

/**
 * The slice of the Web Storage API this module needs. Narrowing it keeps the
 * store testable with a tiny fake and avoids depending on the full `Storage`
 * shape.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The browser's `localStorage`, or `null` when it is unavailable. */
function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Some browsers throw on access in private mode; fall back to memory.
    return null;
  }
}

/** Parse the hidden set stored under `key`, tolerating missing/corrupt data. */
function readStored(storage: StorageLike | null, key: string): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((item): item is string => typeof item === "string"),
    );
  } catch {
    return new Set();
  }
}

/**
 * A store backed by `localStorage`, scoped to one opened folder.
 *
 * Each folder keeps its own key, so hiding a path in one project tree never
 * affects another. The set is held in memory and mirrored to storage on every
 * change, which means the store keeps working for the session when
 * `localStorage` is unavailable or full (jsdom, private-mode browsers) instead
 * of silently forgetting what the user hid.
 *
 * @param folderName - The opened folder's name, used to scope the storage key.
 * @param storage - The backing storage. Defaults to the browser's
 *   `localStorage`; tests inject a fake.
 */
export function createLocalStorageHiddenPathStore(
  folderName: string,
  storage: StorageLike | null = defaultStorage(),
): HiddenPathStore {
  const key = hiddenPathsStorageKey(folderName);
  const hidden = readStored(storage, key);

  const persist = (): void => {
    if (!storage) return;
    try {
      storage.setItem(key, JSON.stringify([...hidden]));
    } catch {
      /* storage full or unavailable: the in-memory copy remains authoritative */
    }
  };

  return {
    list: () => [...hidden],
    hide: (path) => {
      const normalized = normalize(path);
      if (normalized === "") return;
      hidden.add(normalized);
      persist();
    },
    unhide: (path) => {
      hidden.delete(normalize(path));
      persist();
    },
    clear: () => {
      hidden.clear();
      if (!storage) return;
      try {
        storage.removeItem(key);
      } catch {
        /* nothing to clear */
      }
    },
  };
}
