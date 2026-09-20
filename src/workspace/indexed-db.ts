/**
 * IndexedDB implementation of {@link WorkspaceRepository} (Phase 4).
 *
 * The database holds three object stores, all keyed by `id`:
 * - `projects` — every {@link Project}.
 * - `diagrams` — every {@link DiagramFile}, each carrying its `projectId`.
 * - `notes` — every {@link NoteFile}, each carrying its `projectId`.
 *
 * Membership is derived client-side from `Project.datasetIds` / `Project.noteIds`
 * and the stored `projectId`, so no secondary indexes or cursors are needed.
 * Deleting a project removes its diagrams and notes, guaranteeing no orphans.
 *
 * The real `indexedDB` global (callback-based) is bridged to the promise-based
 * {@link IdbFactory} in this module; everything else depends only on that
 * interface, which is what makes the whole layer testable in jsdom.
 */
import type { ProjectMetadata } from "../domain/workspace/metadata";
import type {
  DiagramFile,
  NoteFile,
  Project,
  WorkspaceSnapshot,
} from "../domain/workspace/types";
import {
  newDiagramFileId,
  newNoteId,
  newProjectId,
} from "../domain/workspace/workspace-ids";
import { EMPTY_NOTE_MARKDOWN, uniqueNoteName } from "../domain/workspace/note";
import { uniqueCopyName } from "../domain/workspace/copy-name";
import { uniqueDiagramName } from "../domain/workspace/diagram";
import { err, ok, type Result } from "../shared/result/result";
import type { IdbDatabase, IdbFactory, IdbObjectStore } from "./idb-adapter";
import { openToResult, requestToResult, txDone } from "./idb-promises";
import type { WorkspaceRepository } from "./WorkspaceRepository";

const DB_NAME = "sequencediagrams-db";
/** Version 2 adds the `notes` store; existing databases upgrade in place. */
const DB_VERSION = 2;

const STORE_PROJECTS = "projects";
const STORE_DIAGRAMS = "diagrams";
const STORE_NOTES = "notes";

/**
 * A stored project record: the domain {@link Project} plus the optional sidecar
 * fields the schema has grown.
 *
 * IndexedDB object stores are schemaless, so a new field needs no version bump
 * and an older record simply lacks it. Readers must therefore treat every added
 * field as optional and normalize it away.
 */
type StoredProject = Project & { metadata?: ProjectMetadata };

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
  if (!db.objectStoreNames.contains(STORE_NOTES)) {
    db.createObjectStore(STORE_NOTES, { keyPath: "id" });
  }
}

/** Adapt a real object store to the promise-based {@link IdbObjectStore}. */
export function adaptStore(store: IDBObjectStore): IdbObjectStore {
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
export function adaptDatabase(db: IDBDatabase): IdbDatabase {
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
 * Normalize a stored project, treating a missing note list as empty. The spread
 * carries every optional sidecar field (including `metadata`) through untouched,
 * so normalization never drops data a later read needs.
 */
function normalizeProject(project: StoredProject): StoredProject {
  return {
    ...project,
    datasetIds: project.datasetIds ?? [],
    noteIds: project.noteIds ?? [],
  };
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

  /** Read and normalize a project inside an open transaction. */
  async function readProject(
    stores: Record<string, IdbObjectStore>,
    projectId: string,
  ): Promise<StoredProject | null> {
    const project = (await stores[STORE_PROJECTS].get(projectId)) as
      StoredProject | undefined;
    return project ? normalizeProject(project) : null;
  }

  /** Append an id to one of a project's ordered lists inside a transaction. */
  async function link(
    stores: Record<string, IdbObjectStore>,
    projectId: string,
    field: "datasetIds" | "noteIds",
    id: string,
  ): Promise<void> {
    const project = await readProject(stores, projectId);
    if (!project) return;
    const current = project[field] ?? [];
    if (!current.includes(id)) {
      await stores[STORE_PROJECTS].put({
        ...project,
        [field]: [...current, id],
      } as { id: string });
    }
  }

  /** Remove an id from one of a project's ordered lists inside a transaction. */
  async function unlink(
    stores: Record<string, IdbObjectStore>,
    projectId: string,
    field: "datasetIds" | "noteIds",
    id: string,
  ): Promise<void> {
    const project = await readProject(stores, projectId);
    if (!project) return;
    const current = project[field] ?? [];
    await stores[STORE_PROJECTS].put({
      ...project,
      [field]: current.filter((entry) => entry !== id),
    } as { id: string });
  }

  /** List the files of one store that belong to a project, in stored order. */
  async function listForProject<T extends { id: string; projectId: string }>(
    stores: Record<string, IdbObjectStore>,
    storeName: string,
    project: Project,
    field: "datasetIds" | "noteIds",
  ): Promise<T[]> {
    const all = (await stores[storeName].getAll()) as T[];
    const byId = new Map(all.map((entry) => [entry.id, entry]));
    // Preserve display order; skip any files that were deleted out of band.
    return (project[field] ?? [])
      .map((id) => byId.get(id))
      .filter((entry): entry is T => entry !== undefined);
  }

  return {
    async listProjects(): Promise<Result<Project[], Error>> {
      try {
        const projects = await withTx<Project[]>(
          [STORE_PROJECTS],
          "readonly",
          async (stores) =>
            ((await stores[STORE_PROJECTS].getAll()) as StoredProject[]).map(
              normalizeProject,
            ),
        );
        return ok(projects);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async getProject(id): Promise<Result<Project | null, Error>> {
      try {
        const project = await withTx<Project | null>(
          [STORE_PROJECTS],
          "readonly",
          async (stores) => readProject(stores, id),
        );
        return ok(project);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async createProject(name): Promise<Result<Project, Error>> {
      try {
        // Names are validated upstream, so this is trusted display text.
        const project: Project = {
          id: newProjectId(),
          name,
          datasetIds: [],
          noteIds: [],
        };
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
          [STORE_PROJECTS, STORE_DIAGRAMS, STORE_NOTES],
          "readwrite",
          async (stores) => {
            const project = await readProject(stores, id);
            if (project) {
              for (const diagramId of project.datasetIds) {
                await stores[STORE_DIAGRAMS].delete(diagramId);
              }
              for (const noteId of project.noteIds ?? []) {
                await stores[STORE_NOTES].delete(noteId);
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

    async readProjectMetadata(
      projectId,
    ): Promise<Result<ProjectMetadata | null, Error>> {
      try {
        const metadata = await withTx<ProjectMetadata | null>(
          [STORE_PROJECTS],
          "readonly",
          async (stores) => {
            const project = await readProject(stores, projectId);
            // A record written before metadata existed simply has no field, and
            // reads back as "no metadata" — the migration signal, not an error.
            return project?.metadata ?? null;
          },
        );
        return ok(metadata);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async writeProjectMetadata(
      projectId,
      metadata,
    ): Promise<Result<void, Error>> {
      try {
        await withTx<void>([STORE_PROJECTS], "readwrite", async (stores) => {
          const project = await readProject(stores, projectId);
          if (!project) throw new Error(`Unknown project: ${projectId}`);
          const next: StoredProject = { ...project, metadata };
          await stores[STORE_PROJECTS].put(next);
        });
        return ok(undefined);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async listDiagramFiles(projectId): Promise<Result<DiagramFile[], Error>> {
      try {
        const files = await withTx<DiagramFile[]>(
          [STORE_PROJECTS, STORE_DIAGRAMS],
          "readonly",
          async (stores) => {
            const project = await readProject(stores, projectId);
            if (!project) return [];
            return listForProject<DiagramFile>(
              stores,
              STORE_DIAGRAMS,
              project,
              "datasetIds",
            );
          },
        );
        return ok(files);
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
            await link(stores, projectId, "datasetIds", diagram.id);
          },
        );
        return ok(stored);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async createEmptyDiagram(projectId): Promise<Result<DiagramFile, Error>> {
      try {
        // Create the file inside a transaction that also links it to the
        // project, so the append and the write commit together (all or nothing).
        const diagram = await withTx<DiagramFile>(
          [STORE_PROJECTS, STORE_DIAGRAMS],
          "readwrite",
          async (stores) => {
            const project = await readProject(stores, projectId);
            if (!project) throw new Error(`Unknown project: ${projectId}`);
            const siblings = await listForProject<DiagramFile>(
              stores,
              STORE_DIAGRAMS,
              project,
              "datasetIds",
            );
            const created: DiagramFile = {
              id: newDiagramFileId(),
              name: uniqueDiagramName(siblings.map((entry) => entry.name)),
              source: "",
              projectId,
            };
            await stores[STORE_DIAGRAMS].put(created);
            await link(stores, projectId, "datasetIds", created.id);
            return created;
          },
        );
        return ok(diagram);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async duplicateDiagramFile(
      projectId,
      diagramId,
    ): Promise<Result<DiagramFile, Error>> {
      try {
        const copy = await withTx<DiagramFile>(
          [STORE_PROJECTS, STORE_DIAGRAMS],
          "readwrite",
          async (stores) => {
            const project = await readProject(stores, projectId);
            if (!project) throw new Error(`Unknown project: ${projectId}`);
            const source = (await stores[STORE_DIAGRAMS].get(diagramId)) as
              DiagramFile | undefined;
            if (!source || source.projectId !== projectId) {
              throw new Error(`Unknown diagram: ${diagramId}`);
            }
            const siblings = await listForProject<DiagramFile>(
              stores,
              STORE_DIAGRAMS,
              project,
              "datasetIds",
            );
            const created: DiagramFile = {
              ...source,
              id: newDiagramFileId(),
              name: uniqueCopyName(
                source.name,
                siblings.map((entry) => entry.name),
              ),
            };
            await stores[STORE_DIAGRAMS].put(created);
            await link(stores, projectId, "datasetIds", created.id);
            return created;
          },
        );
        return ok(copy);
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
            await unlink(stores, projectId, "datasetIds", diagramId);
          },
        );
        return ok(undefined);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async renameDiagramFile(
      projectId,
      diagramId,
      newName,
    ): Promise<Result<DiagramFile, Error>> {
      try {
        const name = newName.trim();
        if (name === "") return err(new Error("A diagram name is required"));
        const renamed = await withTx<DiagramFile>(
          [STORE_PROJECTS, STORE_DIAGRAMS],
          "readwrite",
          async (stores) => {
            const project = await readProject(stores, projectId);
            if (!project) throw new Error(`Unknown project: ${projectId}`);
            const diagram = (await stores[STORE_DIAGRAMS].get(diagramId)) as
              DiagramFile | undefined;
            if (!diagram || diagram.projectId !== projectId) {
              throw new Error(`Unknown diagram: ${diagramId}`);
            }
            const siblings = await listForProject<DiagramFile>(
              stores,
              STORE_DIAGRAMS,
              project,
              "datasetIds",
            );
            if (siblings.some((d) => d.id !== diagramId && d.name === name)) {
              throw new Error(`A diagram named "${name}" already exists`);
            }
            const next: DiagramFile = { ...diagram, name };
            await stores[STORE_DIAGRAMS].put(next);
            return next;
          },
        );
        return ok(renamed);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async listNoteFiles(projectId): Promise<Result<NoteFile[], Error>> {
      try {
        const files = await withTx<NoteFile[]>(
          [STORE_PROJECTS, STORE_NOTES],
          "readonly",
          async (stores) => {
            const project = await readProject(stores, projectId);
            if (!project) return [];
            return listForProject<NoteFile>(
              stores,
              STORE_NOTES,
              project,
              "noteIds",
            );
          },
        );
        return ok(files);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async getNoteFile(
      projectId,
      noteId,
    ): Promise<Result<NoteFile | null, Error>> {
      try {
        const note = await withTx<NoteFile | undefined>(
          [STORE_NOTES],
          "readonly",
          async (stores) =>
            (await stores[STORE_NOTES].get(noteId)) as NoteFile | undefined,
        );
        if (!note || note.projectId !== projectId) return ok(null);
        return ok(note);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async saveNoteFile(projectId, note): Promise<Result<NoteFile, Error>> {
      try {
        const stored: NoteFile = { ...note, projectId };
        await withTx<void>(
          [STORE_PROJECTS, STORE_NOTES],
          "readwrite",
          async (stores) => {
            await stores[STORE_NOTES].put(stored);
            await link(stores, projectId, "noteIds", note.id);
          },
        );
        return ok(stored);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async createEmptyNote(projectId): Promise<Result<NoteFile, Error>> {
      try {
        const note = await withTx<NoteFile>(
          [STORE_PROJECTS, STORE_NOTES],
          "readwrite",
          async (stores) => {
            const project = await readProject(stores, projectId);
            if (!project) throw new Error(`Unknown project: ${projectId}`);
            const siblings = await listForProject<NoteFile>(
              stores,
              STORE_NOTES,
              project,
              "noteIds",
            );
            const created: NoteFile = {
              id: newNoteId(),
              name: uniqueNoteName(siblings.map((entry) => entry.name)),
              markdown: EMPTY_NOTE_MARKDOWN,
              projectId,
            };
            await stores[STORE_NOTES].put(created);
            await link(stores, projectId, "noteIds", created.id);
            return created;
          },
        );
        return ok(note);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async duplicateNoteFile(
      projectId,
      noteId,
    ): Promise<Result<NoteFile, Error>> {
      try {
        const copy = await withTx<NoteFile>(
          [STORE_PROJECTS, STORE_NOTES],
          "readwrite",
          async (stores) => {
            const project = await readProject(stores, projectId);
            if (!project) throw new Error(`Unknown project: ${projectId}`);
            const source = (await stores[STORE_NOTES].get(noteId)) as
              NoteFile | undefined;
            if (!source || source.projectId !== projectId) {
              throw new Error(`Unknown note: ${noteId}`);
            }
            const siblings = await listForProject<NoteFile>(
              stores,
              STORE_NOTES,
              project,
              "noteIds",
            );
            const created: NoteFile = {
              ...source,
              id: newNoteId(),
              name: uniqueCopyName(
                source.name,
                siblings.map((entry) => entry.name),
              ),
            };
            await stores[STORE_NOTES].put(created);
            await link(stores, projectId, "noteIds", created.id);
            return created;
          },
        );
        return ok(copy);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async deleteNoteFile(projectId, noteId): Promise<Result<void, Error>> {
      try {
        await withTx<void>(
          [STORE_PROJECTS, STORE_NOTES],
          "readwrite",
          async (stores) => {
            await stores[STORE_NOTES].delete(noteId);
            await unlink(stores, projectId, "noteIds", noteId);
          },
        );
        return ok(undefined);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async renameNoteFile(
      projectId,
      noteId,
      newName,
    ): Promise<Result<NoteFile, Error>> {
      try {
        const name = newName.trim();
        if (name === "") return err(new Error("A note name is required"));
        const renamed = await withTx<NoteFile>(
          [STORE_PROJECTS, STORE_NOTES],
          "readwrite",
          async (stores) => {
            const project = await readProject(stores, projectId);
            if (!project) throw new Error(`Unknown project: ${projectId}`);
            const note = (await stores[STORE_NOTES].get(noteId)) as
              NoteFile | undefined;
            if (!note || note.projectId !== projectId) {
              throw new Error(`Unknown note: ${noteId}`);
            }
            const siblings = await listForProject<NoteFile>(
              stores,
              STORE_NOTES,
              project,
              "noteIds",
            );
            if (siblings.some((n) => n.id !== noteId && n.name === name)) {
              throw new Error(`A note named "${name}" already exists`);
            }
            const next: NoteFile = { ...note, name };
            await stores[STORE_NOTES].put(next);
            return next;
          },
        );
        return ok(renamed);
      } catch (error) {
        return err(toRepoError(error));
      }
    },

    async listAll(): Promise<Result<WorkspaceSnapshot, Error>> {
      try {
        const [projects, diagrams, notes] = await Promise.all([
          withTx<Project[]>([STORE_PROJECTS], "readonly", async (stores) =>
            ((await stores[STORE_PROJECTS].getAll()) as StoredProject[]).map(
              normalizeProject,
            ),
          ),
          withTx<DiagramFile[]>(
            [STORE_DIAGRAMS],
            "readonly",
            async (stores) =>
              (await stores[STORE_DIAGRAMS].getAll()) as DiagramFile[],
          ),
          withTx<NoteFile[]>(
            [STORE_NOTES],
            "readonly",
            async (stores) =>
              (await stores[STORE_NOTES].getAll()) as NoteFile[],
          ),
        ]);
        return ok({ projects, diagrams, notes });
      } catch (error) {
        return err(toRepoError(error));
      }
    },
  };
}
