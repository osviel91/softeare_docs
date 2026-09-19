/**
 * Helpers for bridging IndexedDB's callback-based requests to native promises.
 *
 * The real IndexedDB API reports success/failure through `onsuccess`/`onerror`
 * events on `IDBRequest`. These wrappers convert those events into promises so
 * the repository can use straightforward `await`/`try/catch` flow. They are the
 * only place that reaches for IndexedDB's concrete request types.
 */

/** Wrap an `IDBRequest` in a promise that resolves with its `.result`. */
export function requestToResult<T>(request: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Wrap an `IDBOpenDBRequest` in a promise, honoring `onupgradeneeded`. */
export function openToResult(request: IDBOpenDBRequest): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open database"));
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Wrap an `IDBTransaction` in a promise that resolves on commit and rejects on
 * abort/error. IndexedDB reports transaction completion through `oncomplete`/
 * `onerror`, so this bridges those events to a native promise.
 */
export function txDone(request: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    request.oncomplete = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Transaction failed"));
    request.onabort = () =>
      reject(request.error ?? new Error("Transaction aborted"));
  });
}
