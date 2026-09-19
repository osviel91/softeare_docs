/**
 * IndexedDB implementation of {@link WorkspaceRepository} (Phase 4).
 *
 * The database holds two object stores, both keyed by `id`:
 * - `projects` — every {@link Project}.
 * - `diagrams` — every {@link DiagramFile}, each carrying its `projectId`.
 *
 * Diagram-to-project membership is derived client-side from `Project.datasetIds`
 * and the stored `projectId`, so no secondary indexes or cursors are needed.
 * Deleting a project removes its diagrams, guaranteeing no orphans.
 *
 * The real `indexedDB` global (callback-based) is bridged to the promise-based
 * {@link IdbFactory} in this module; everything else depends only on that
 * interface, which is what makes the whole layer testable in jsdom.
 */
import type {
  DiagramFile,
  Project,
  WorkspaceSnapshot,
} from "../domain/workspace/types";
import { newProjectId } from "../domain/workspace/workspace-ids";
import { err, ok, type Result } from "../shared/result/result";
import type { IdbDatabase, IdbFactory, IdbObjectStore } from "./idb-adapter";
import { openToResult, requestToResult, txDone } from "./idb-promises";
import type { WorkspaceRepository } from "./WorkspaceRepository";

const DB_NAME = "sequencediagrams-db";
const DB_VERSION = 1;

const STORE_PROJECTS = "projects";
const STORE_DIAGRAMS = "diagrams";

/**
 * Create the object stores on first creation or version bump. Kept in this
 * module so the real factory can register it as its `onupgradeneeded` handler;
 * the repository never needs to know about schema details.
 */
export function createSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
    db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains(STORE_DIAGRAMS)) {
    db.createObjectStore(STORE_DIAGRAMS, { keyPath: "id" });
  }
}

/** Adapt a real object store to the promise-based {@link IdbObjectStore}. */
function adaptStore(store: IDBObjectStore): IdbObjectStore {
  return {
    get: (key) => requestToResult<unknown>(store.get(key)),
    getAll: () => requestToResult<unknown[]>(store.getAll()),
    put: (value) => requestToResult<string>(store.put(value)),
    delete: (key) => requestToResult<void>(store.delete(key)),
  };
}

/**
 * Adapt a real database to {@link IdbDatabase}. The real transaction exposes no
 * `done` promise, so this wraps one (via {@link txDone}) plus the store handles.
 */
function adaptDatabase(db: IDBDatabase): IdbDatabase {
  return {
    transaction(storeNames, mode) {
      const tx = db.transaction(storeNames, mode);
      return {
        objectStore: (name) => adaptStore(tx.objectStore(name)),
        done: txDone(tx),
        abort: () => tx.abort(),
      };
    },
    close() {
      db.close();
    },
  };
}

/** A factory backed by the real, callback-based IndexedDB global. */
class RealIndexedDbFactory implements IdbFactory {
  async open(name: string): Promise<IdbDatabase> {
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is not available in this environment");
    }
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => createSchema(request.result);
    return adaptDatabase(await openToResult(request));
  }
}

/** Turn any unexpected error into a plain, serializable Error. */
function toRepoError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Build a {@link WorkspaceRepository} over IndexedDB.
 *
 * @param factory - The database opener. Defaults to the real IndexedDB global;
 *   tests inject an in-memory fake so no browser API is required.
 */
export function createIndexedDbRepository(
  factory: IdbFactory = new RealIndexedDbFactory(),
): WorkspaceRepository {
  /** Open the database, creating it on first use. */
  async function openDb(): Promise<IdbDatabase> {
    return factory.open(DB_NAME);
  }

  /**
   * Run `run` inside a transaction over `storeNames`, awaiting commit. Any
   * failure aborts the transaction and is surfaced to the caller.
   */
  async function withTx<T>(
    storeNames: string[],
    mode: "readonly" | "readwrite",
    run: (stores: Record<string, IdbObjectStore>) => Promise<T>,
  ): Promise<T> {
    const db = await openDb();
    try {
      const tx = db.transaction(storeNames, mode);
      const stores = Object.fromEntries(
        storeNames.map((name) => [name, tx.objectStore(name)]),
      );
      try {
        const result = await run(stores as Record<string, IdbObjectStore>);
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

  return {
    async listProjects(): Promise<Result<Project[], Error>> {
      try {
        const projects = await withTx<Project[]>(
          [STORE_PROJECTS],
          "readonly",
          async (stores) =>
            (await stores[STORE_PROJECTS].getAll()) as Project[],
        );
        return ok(projects);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async getProject(id): Promise<Result<Project | null, Error>> {
      try {
        const project = await withTx<Project | undefined>(
          [STORE_PROJECTS],
          "readonly",
          async (stores) =>
            (await stores[STORE_PROJECTS].get(id)) as Project | undefined,
        );
        return ok(project ?? null);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async createProject(name): Promise<Result<Project, Error>> {
      try {
        // Names are validated upstream, so this is trusted display text.
        const project: Project = { id: newProjectId(), name, datasetIds: [] };
        await withTx<void>([STORE_PROJECTS], "readwrite", async (stores) => {
          await stores[STORE_PROJECTS].put(project);
        });
        return ok(project);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async deleteProject(id): Promise<Result<void, Error>> {
      try {
        await withTx<void>(
          [STORE_PROJECTS, STORE_DIAGRAMS],
          "readwrite",
          async (stores) => {
            const project = (await stores[STORE_PROJECTS].get(id)) as
              Project | undefined;
            if (project) {
              for (const diagramId of project.datasetIds) {
                await stores[STORE_DIAGRAMS].delete(diagramId);
              }
            }
            await stores[STORE_PROJECTS].delete(id);
          },
        );
        return ok(undefined);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async listDiagramFiles(projectId): Promise<Result<DiagramFile[], Error>> {
      try {
        const project = await withTx<Project | undefined>(
          [STORE_PROJECTS],
          "readonly",
          async (stores) =>
            (await stores[STORE_PROJECTS].get(projectId)) as
              Project | undefined,
        );
        if (!project) return ok([]);
        const all = await withTx<DiagramFile[]>(
          [STORE_DIAGRAMS],
          "readonly",
          async (stores) =>
            (await stores[STORE_DIAGRAMS].getAll()) as DiagramFile[],
        );
        const byId = new Map(all.map((d) => [d.id, d]));
        // Preserve display order; skip any files that were deleted out of band.
        return ok(
          project.datasetIds
            .map((did) => byId.get(did))
            .filter(Boolean) as DiagramFile[],
        );
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async getDiagramFile(
      projectId,
      diagramId,
    ): Promise<Result<DiagramFile | null, Error>> {
      try {
        const diagram = await withTx<DiagramFile | undefined>(
          [STORE_DIAGRAMS],
          "readonly",
          async (stores) =>
            (await stores[STORE_DIAGRAMS].get(diagramId)) as
              DiagramFile | undefined,
        );
        // Only return files that actually belong to the requested project.
        if (!diagram || diagram.projectId !== projectId) return ok(null);
        return ok(diagram);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async saveDiagramFile(
      projectId,
      diagram,
    ): Promise<Result<DiagramFile, Error>> {
      try {
        const stored: DiagramFile = { ...diagram, projectId };
        await withTx<void>(
          [STORE_PROJECTS, STORE_DIAGRAMS],
          "readwrite",
          async (stores) => {
            await stores[STORE_DIAGRAMS].put(stored);
            const project = (await stores[STORE_PROJECTS].get(projectId)) as
              Project | undefined;
            if (project && !project.datasetIds.includes(diagram.id)) {
              project.datasetIds = [...project.datasetIds, diagram.id];
              await stores[STORE_PROJECTS].put(project);
            }
          },
        );
        return ok(stored);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async deleteDiagramFile(
      projectId,
      diagramId,
    ): Promise<Result<void, Error>> {
      try {
        await withTx<void>(
          [STORE_PROJECTS, STORE_DIAGRAMS],
          "readwrite",
          async (stores) => {
            await stores[STORE_DIAGRAMS].delete(diagramId);
            const project = (await stores[STORE_PROJECTS].get(projectId)) as
              Project | undefined;
            if (project) {
              project.datasetIds = project.datasetIds.filter(
                (did) => did !== diagramId,
              );
              await stores[STORE_PROJECTS].put(project);
            }
          },
        );
        return ok(undefined);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async listAll(): Promise<Result<WorkspaceSnapshot, Error>> {
      try {
        const [projects, diagrams] = await Promise.all([
          withTx<Project[]>(
            [STORE_PROJECTS],
            "readonly",
            async (stores) =>
              (await stores[STORE_PROJECTS].getAll()) as Project[],
          ),
          withTx<DiagramFile[]>(
            [STORE_DIAGRAMS],
            "readonly",
            async (stores) =>
              (await stores[STORE_DIAGRAMS].getAll()) as DiagramFile[],
          ),
        ]);
        return ok({ projects, diagrams });
      } catch (error) {
        return err(toRepoError(error));
      }
    },
  };
}
