/**
 * IndexedDB implementation of {@link VersionHistoryStore}.
 *
 * Version timelines live in their own database, separate from the workspace
 * database, because they are app-local metadata: they must survive independently
 * of which repository (in-browser projects or a local folder) is active, and they
 * are cleared explicitly when a diagram or project is deleted on disk.
 *
 * The database holds one object store keyed by version id. A version carries its
 * `diagramId`, so a diagram's timeline is a client-side filter over `getAll()` —
 * the same cacheless, index-free approach the workspace repository takes, and
 * more than fast enough for a bounded (see `MAX_VERSIONS_PER_DIAGRAM`) timeline.
 */
import type { DiagramVersion } from "../domain/workspace/version";
import { err, ok, type Result } from "../shared/result/result";
import type { IdbDatabase, IdbFactory, IdbObjectStore } from "./idb-adapter";
import { adaptDatabase } from "./indexed-db";
import { openToResult } from "./idb-promises";
import {
  latestVersion,
  makeVersion,
  prependAndPrune,
  shouldRecordVersion,
  type RecordVersionInput,
  type VersionHistoryStore,
} from "./version-history";

const DB_NAME = "sequencediagrams-versions-db";
const DB_VERSION = 1;
const STORE_VERSIONS = "versions";

/** Create the version store on first creation or version bump. */
export function createVersionHistorySchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE_VERSIONS)) {
    db.createObjectStore(STORE_VERSIONS, { keyPath: "id" });
  }
}

/** A factory backed by the real, callback-based IndexedDB global. */
class RealVersionDbFactory implements IdbFactory {
  async open(name: string): Promise<IdbDatabase> {
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is not available in this environment");
    }
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => createVersionHistorySchema(request.result);
    return adaptDatabase(await openToResult(request));
  }
}

/** Turn any unexpected error into a plain, serializable Error. */
function toRepoError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Order a stored timeline newest-first.
 *
 * `getAll()` returns entries in insertion order and versions are immutable, so
 * reversing that order is both correct and deterministic — unlike a `createdAt`
 * sort, which would tie for versions recorded within the same millisecond.
 */
function newestFirst(versions: DiagramVersion[]): DiagramVersion[] {
  return [...versions].reverse();
}

/**
 * Build a {@link VersionHistoryStore} over IndexedDB.
 *
 * @param factory - The database opener. Defaults to the real IndexedDB global;
 *   tests inject an in-memory fake so no browser API is required.
 */
export function createIndexedDbVersionHistory(
  factory: IdbFactory = new RealVersionDbFactory(),
): VersionHistoryStore {
  async function openDb(): Promise<IdbDatabase> {
    return factory.open(DB_NAME);
  }

  /** Run `run` in a transaction over the version store, awaiting commit. */
  async function withTx<T>(
    mode: "readonly" | "readwrite",
    run: (store: IdbObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await openDb();
    try {
      const tx = db.transaction([STORE_VERSIONS], mode);
      const store = tx.objectStore(STORE_VERSIONS);
      try {
        const result = await run(store);
        await tx.done;
        return result;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          /* abort failures are informational; the original error wins */
        }
        throw error;
      }
    } finally {
      db.close();
    }
  }

  /** Every stored version, for the target diagram, newest first. */
  async function readTimeline(diagramId: string): Promise<DiagramVersion[]> {
    const all = await withTx<DiagramVersion[]>(
      "readonly",
      async (store) => (await store.getAll()) as DiagramVersion[],
    );
    return newestFirst(
      all.filter((version) => version.diagramId === diagramId),
    );
  }

  return {
    async listVersions(
      diagramId: string,
    ): Promise<Result<DiagramVersion[], Error>> {
      try {
        return ok(await readTimeline(diagramId));
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async recordVersion(
      input: RecordVersionInput,
    ): Promise<Result<DiagramVersion, Error>> {
      try {
        return ok(
          await withTx<DiagramVersion>("readwrite", async (store) => {
            const all = (await store.getAll()) as DiagramVersion[];
            const timeline = newestFirst(
              all.filter((version) => version.diagramId === input.diagramId),
            );
            if (!shouldRecordVersion(timeline, input.source)) {
              // Nothing changed: return the newest version untouched.
              return latestVersion(timeline) as DiagramVersion;
            }
            const version = makeVersion(input);
            const next = prependAndPrune(timeline, version);
            const keep = new Set(next.map((entry) => entry.id));
            await store.put(version);
            // Prune the entries the cap pushed off the end of the timeline.
            for (const entry of all) {
              if (entry.diagramId === input.diagramId && !keep.has(entry.id)) {
                await store.delete(entry.id);
              }
            }
            return version;
          }),
        );
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async deleteVersion(versionId: string): Promise<Result<void, Error>> {
      try {
        await withTx<void>("readwrite", async (store) => {
          await store.delete(versionId);
        });
        return ok(undefined);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async clearDiagram(diagramId: string): Promise<Result<void, Error>> {
      try {
        await withTx<void>("readwrite", async (store) => {
          const all = (await store.getAll()) as DiagramVersion[];
          for (const version of all) {
            if (version.diagramId === diagramId) await store.delete(version.id);
          }
        });
        return ok(undefined);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async clearProject(projectId: string): Promise<Result<void, Error>> {
      try {
        await withTx<void>("readwrite", async (store) => {
          const all = (await store.getAll()) as DiagramVersion[];
          for (const version of all) {
            if (version.projectId === projectId) await store.delete(version.id);
          }
        });
        return ok(undefined);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async renameDiagram(
      fromDiagramId: string,
      toDiagramId: string,
    ): Promise<Result<void, Error>> {
      try {
        if (fromDiagramId === toDiagramId) return ok(undefined);
        await withTx<void>("readwrite", async (store) => {
          const all = (await store.getAll()) as DiagramVersion[];
          for (const version of all) {
            if (version.diagramId !== fromDiagramId) continue;
            // Version ids are independent of the diagram id, so the entry is
            // updated in place rather than moved.
            await store.put({ ...version, diagramId: toDiagramId } as {
              id: string;
            });
          }
        });
        return ok(undefined);
      } catch (error) {
        return err(toRepoError(error));
      }
    },
  };
}
