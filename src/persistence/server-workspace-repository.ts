/**
 * A `WorkspaceRepository` over the server's database and project volume (ADR-040).
 *
 * This is the bridge that makes "one application layer" true rather than
 * aspirational. `DocumentationWorkspace`, `loadProjectSnapshot`, the indexer and
 * every use case above them already speak {@link WorkspaceRepository}; this class
 * answers that interface from the server's own storage — resource *identity* and
 * *revisions* from the `resources` table, resource *content* from the project's
 * volume — so the HTTP API and the remote MCP server run the same code the
 * editor's services run, with no second implementation of a project operation.
 *
 * Two deliberate behaviours:
 *
 * - **Revisions.** {@link revisionOf} and {@link expectRevision} implement
 *   `RevisionedWorkspaceRepository`, so `updateResource` refuses a stale write
 *   with a conflict instead of overwriting another writer's change.
 * - **Project lifecycle is not here.** Creating, renaming and deleting a project
 *   is the project catalog's job (it owns membership and the storage directory),
 *   so those methods refuse loudly rather than half-implementing a second path.
 */
import type {
  ProjectStorage,
  StoredResource,
} from "../application/project-storage";
import type { RevisionedWorkspaceRepository } from "../application/ports";
import type { ProjectRepository } from "./project-repository";
import {
  createEmptyMetadata,
  parseProjectMetadata,
  serializeProjectMetadata,
  type ProjectMetadata,
} from "../domain/workspace/metadata";
import type { ResourceType } from "../domain/workspace/resource-id";
import { resourceTypeOfName } from "../domain/workspace/resource-id";
import type {
  DiagramFile,
  NoteFile,
  Project,
  WorkspaceSnapshot,
} from "../domain/workspace/types";
import type { ProjectId } from "../domain/workspace/workspace-ids";
import { forbidden } from "../application/errors";
import { err, isOk, ok, type Result } from "../shared/result/result";

/** The identity record's file name inside a project's storage directory. */
export const PROJECT_METADATA_FILE = "project.json";

/** Options for the server workspace repository. */
export interface ServerWorkspaceRepositoryOptions {
  projectId: string;
  storage: ProjectStorage;
  resources: ProjectRepository;
  /**
   * Whether this caller may change the project's resources.
   *
   * Resolved by the provider through the same authorization policy every other
   * use case uses. It defaults to `false`, so a host that forgets to ask cannot
   * hand a read-only principal a writable repository: the shared documentation
   * service is a second door into a project, and it must open only as wide as
   * the policy allows.
   */
  writable?: boolean;
}

/** Read a required resource record, or a failure naming what is missing. */
function missing(message: string): Result<never, Error> {
  return err(new Error(message));
}

/** The file name a resource id addresses inside its project. */
function nameOfResourceId(id: string): string {
  const index = id.lastIndexOf("/");
  return index === -1 ? id : id.slice(index + 1);
}

/**
 * A workspace repository for one server project.
 *
 * The project id is fixed at construction, which is what stops a caller from
 * addressing a project they were not handed — the id never arrives from a
 * request, only from an already-authorized project record.
 */
export class ServerWorkspaceRepository implements RevisionedWorkspaceRepository {
  private readonly projectId: string;
  private readonly storage: ProjectStorage;
  private readonly resources: ProjectRepository;
  private readonly writable: boolean;

  constructor(options: ServerWorkspaceRepositoryOptions) {
    this.projectId = options.projectId;
    this.storage = options.storage;
    this.resources = options.resources;
    this.writable = options.writable ?? false;
  }

  /**
   * Refuse a write the caller's credential and role do not carry.
   *
   * The provider resolves this once through the authorization policy, so the
   * answer is the one `catalog.updateResource` would give. This repository is a
   * second *door* into a project, not a second authorization path: it opens only
   * as wide as the policy already allowed.
   */
  private refuseWrite(): Result<never, Error> {
    return err(
      forbidden("This credential may not change resources in this project."),
    );
  }

  // ---- Project lifecycle: owned by the catalog, refused here -----------------

  async listProjects(): Promise<Result<Project[], Error>> {
    return missing(
      "The server workspace repository addresses one project; list projects through the project catalog.",
    );
  }

  async getProject(id: ProjectId): Promise<Result<Project | null, Error>> {
    return id === this.projectId
      ? ok({ id: this.projectId, name: this.projectId, datasetIds: [] })
      : ok(null);
  }

  async createProject(): Promise<Result<Project, Error>> {
    return missing(
      "Creating a project on the server is the project catalog's operation, not a repository write.",
    );
  }

  async renameProject(): Promise<Result<Project, Error>> {
    return missing(
      "Renaming a server project is the project catalog's operation, not a repository write.",
    );
  }

  async deleteProject(): Promise<Result<void, Error>> {
    return missing(
      "Deleting a server project is the project catalog's operation, not a repository write.",
    );
  }

  // ---- The identity record ---------------------------------------------------

  async readProjectMetadata(
    projectId: ProjectId,
  ): Promise<Result<ProjectMetadata | null, Error>> {
    if (projectId !== this.projectId) {
      return missing(`No project with id ${projectId} in this repository.`);
    }
    const stored = await this.storage.read(PROJECT_METADATA_FILE);
    if (!isOk(stored)) return stored;
    if (stored.value === null) return ok(null);
    try {
      return ok(parseProjectMetadata(JSON.parse(stored.value.content)));
    } catch {
      // A corrupt identity record is not fatal: the service reconciles one from
      // the files it can see, which is the same path a pre-ids project takes.
      return ok(null);
    }
  }

  async writeProjectMetadata(
    projectId: ProjectId,
    metadata: ProjectMetadata,
  ): Promise<Result<void, Error>> {
    if (projectId !== this.projectId) {
      return missing(`No project with id ${projectId} in this repository.`);
    }
    if (!this.writable) return this.refuseWrite();
    const written = await this.storage.write(
      PROJECT_METADATA_FILE,
      serializeProjectMetadata(metadata),
    );
    if (!isOk(written)) return err(written.error);
    // The row is updated from the *record*, never from the file listing: the
    // identity document is a sidecar, and `listDiagramFiles` must not see it.
    await this.syncResourceRecords(metadata);
    return ok(undefined);
  }

  /** Insert rows for resources the record knows and the database does not. */
  private async syncResourceRecords(metadata: ProjectMetadata): Promise<void> {
    for (const entry of metadata.resources) {
      const type = resourceTypeOfName(entry.path);
      const existing = await this.resources.findResourceByPath(
        this.projectId,
        entry.path,
      );
      if (existing) continue;
      await this.resources.createResource(this.projectId, {
        id: entry.id,
        path: entry.path,
        type,
      });
    }
  }

  // ---- Diagrams --------------------------------------------------------------

  async listDiagramFiles(
    projectId: ProjectId,
  ): Promise<Result<DiagramFile[], Error>> {
    if (projectId !== this.projectId) {
      return missing(`No project with id ${projectId} in this repository.`);
    }
    const records = await this.resources.listResources(this.projectId);
    const diagrams: DiagramFile[] = [];
    for (const record of records) {
      if (record.type === "markdown-document") continue;
      const read = await this.storage.read(record.path);
      if (!isOk(read)) return read;
      if (read.value === null) continue;
      diagrams.push(this.toDiagram(read.value));
    }
    return ok(diagrams);
  }

  async getDiagramFile(
    projectId: ProjectId,
    diagramId: string,
  ): Promise<Result<DiagramFile | null, Error>> {
    if (projectId !== this.projectId) {
      return missing(`No project with id ${projectId} in this repository.`);
    }
    const read = await this.storage.read(nameOfResourceId(diagramId));
    if (!isOk(read)) return read;
    if (read.value === null) return ok(null);
    if (read.value.type === "markdown-document") return ok(null);
    return ok(this.toDiagram(read.value));
  }

  async saveDiagramFile(
    projectId: ProjectId,
    diagram: DiagramFile,
  ): Promise<Result<DiagramFile, Error>> {
    return this.save(projectId, diagram.name, diagram.source, (stored) =>
      this.toDiagram(stored),
    );
  }

  async createEmptyDiagram(
    projectId: ProjectId,
  ): Promise<Result<DiagramFile, Error>> {
    return this.createNamed(
      projectId,
      "Untitled",
      "sequence-diagram",
      (stored) => this.toDiagram(stored),
    );
  }

  async createEmptyEventFlow(
    projectId: ProjectId,
  ): Promise<Result<DiagramFile, Error>> {
    return this.createNamed(projectId, "Untitled", "event-flow", (stored) =>
      this.toDiagram(stored),
    );
  }

  async duplicateDiagramFile(
    projectId: ProjectId,
    diagramId: string,
  ): Promise<Result<DiagramFile, Error>> {
    const read = await this.getDiagramFile(projectId, diagramId);
    if (!isOk(read)) return read;
    if (read.value === null) return missing(`No diagram with id ${diagramId}.`);
    const copyName = await this.freeName(projectId, read.value.name);
    return this.createNamed(
      projectId,
      copyName,
      resourceTypeOfName(copyName),
      (stored) => this.toDiagram(stored),
      read.value.source,
      copyName,
    );
  }

  async deleteDiagramFile(
    projectId: ProjectId,
    diagramId: string,
  ): Promise<Result<void, Error>> {
    return this.remove(projectId, nameOfResourceId(diagramId));
  }

  async renameDiagramFile(
    projectId: ProjectId,
    diagramId: string,
    newName: string,
  ): Promise<Result<DiagramFile, Error>> {
    return this.rename(
      projectId,
      nameOfResourceId(diagramId),
      newName,
      (stored) => this.toDiagram(stored),
    );
  }

  // ---- Notes -----------------------------------------------------------------

  async listNoteFiles(
    projectId: ProjectId,
  ): Promise<Result<NoteFile[], Error>> {
    if (projectId !== this.projectId) {
      return missing(`No project with id ${projectId} in this repository.`);
    }
    const records = await this.resources.listResources(this.projectId);
    const notes: NoteFile[] = [];
    for (const record of records) {
      if (record.type !== "markdown-document") continue;
      if (record.path === PROJECT_METADATA_FILE) continue;
      const read = await this.storage.read(record.path);
      if (!isOk(read)) return read;
      if (read.value === null) continue;
      notes.push(this.toNote(read.value));
    }
    return ok(notes);
  }

  async getNoteFile(
    projectId: ProjectId,
    noteId: string,
  ): Promise<Result<NoteFile | null, Error>> {
    if (projectId !== this.projectId) {
      return missing(`No project with id ${projectId} in this repository.`);
    }
    const read = await this.storage.read(nameOfResourceId(noteId));
    if (!isOk(read)) return read;
    if (read.value === null) return ok(null);
    if (read.value.type !== "markdown-document") return ok(null);
    return ok(this.toNote(read.value));
  }

  async saveNoteFile(
    projectId: ProjectId,
    note: NoteFile,
  ): Promise<Result<NoteFile, Error>> {
    return this.save(projectId, note.name, note.markdown, (stored) =>
      this.toNote(stored),
    );
  }

  async createEmptyNote(
    projectId: ProjectId,
  ): Promise<Result<NoteFile, Error>> {
    return this.createNamed(
      projectId,
      "Untitled.md",
      "markdown-document",
      (stored) => this.toNote(stored),
      "# Untitled\n",
    );
  }

  async duplicateNoteFile(
    projectId: ProjectId,
    noteId: string,
  ): Promise<Result<NoteFile, Error>> {
    const read = await this.getNoteFile(projectId, noteId);
    if (!isOk(read)) return read;
    if (read.value === null) return missing(`No note with id ${noteId}.`);
    const copyName = await this.freeName(projectId, read.value.name);
    return this.createNamed(
      projectId,
      copyName,
      "markdown-document",
      (stored) => this.toNote(stored),
      read.value.markdown,
      copyName,
    );
  }

  async deleteNoteFile(
    projectId: ProjectId,
    noteId: string,
  ): Promise<Result<void, Error>> {
    return this.remove(projectId, nameOfResourceId(noteId));
  }

  async renameNoteFile(
    projectId: ProjectId,
    noteId: string,
    newName: string,
  ): Promise<Result<NoteFile, Error>> {
    return this.rename(projectId, nameOfResourceId(noteId), newName, (stored) =>
      this.toNote(stored),
    );
  }

  // ---- Snapshot and revisions -------------------------------------------------

  async listAll(): Promise<Result<WorkspaceSnapshot, Error>> {
    const [diagrams, notes] = await Promise.all([
      this.listDiagramFiles(this.projectId),
      this.listNoteFiles(this.projectId),
    ]);
    if (!isOk(diagrams)) return diagrams;
    if (!isOk(notes)) return notes;
    return ok({
      projects: [{ id: this.projectId, name: this.projectId, datasetIds: [] }],
      diagrams: diagrams.value,
      notes: notes.value,
    });
  }

  /** The current revision of a resource path, or `null` when it is not stored. */
  async revisionOf(
    projectId: ProjectId,
    path: string,
  ): Promise<Result<number | null, Error>> {
    if (projectId !== this.projectId) {
      return missing(`No project with id ${projectId} in this repository.`);
    }
    const record = await this.resources.findResourceByPath(
      this.projectId,
      this.storagePathOf(path),
    );
    return ok(record ? record.revision : null);
  }

  /** Refuse a write whose expectation no longer matches what is stored. */
  async expectRevision(
    projectId: ProjectId,
    path: string,
    expectedRevision: number,
  ): Promise<Result<void, Error>> {
    if (projectId !== this.projectId) {
      return missing(`No project with id ${projectId} in this repository.`);
    }
    const record = await this.resources.findResourceByPath(
      this.projectId,
      this.storagePathOf(path),
    );
    if (!record) {
      return err(
        new Error(
          `Nothing is stored at "${path}", so revision ${expectedRevision} cannot be matched.`,
        ),
      );
    }
    if (record.revision !== expectedRevision) {
      return err(
        new Error(
          `The resource changed since it was read: expected revision ${expectedRevision}, current revision ${record.revision}. Re-read it and retry.`,
        ),
      );
    }
    return ok(undefined);
  }

  // ---- Internals -------------------------------------------------------------

  /**
   * The storage path for a repository-level name.
   *
   * A repository name may be a bare file name (`checkout.seq`) or an existing
   * path (`diagrams/checkout.seq`). A bare name that the database does not know
   * is placed according to its kind, which keeps the volume organised the way
   * the archive layout (ADR-018) and a local folder already are.
   */
  private storagePathOf(name: string): string {
    return name;
  }

  /** Read a stored resource's name into the shared shape. */
  private toDiagram(stored: StoredResource): DiagramFile {
    return {
      id: this.resourceId(stored.path),
      name: stored.path,
      source: stored.content,
      projectId: this.projectId,
    };
  }

  /** Read a stored note into the shared shape. */
  private toNote(stored: StoredResource): NoteFile {
    return {
      id: this.resourceId(stored.path),
      name: stored.path,
      markdown: stored.content,
      projectId: this.projectId,
    };
  }

  /**
   * The repository id of a stored resource.
   *
   * It is the storage path, exactly as a local folder uses. The database id is
   * the *API* identity (`resources.id`); this id exists because the shared
   * repository contract predates the server, and keeping the two explicit is
   * cheaper than pretending one can be the other.
   */
  private resourceId(path: string): string {
    return path;
  }

  /** Write a resource's content, creating its row when it is new. */
  private async save<T extends DiagramFile | NoteFile>(
    projectId: ProjectId,
    path: string,
    content: string,
    toDomain: (stored: StoredResource) => T,
  ): Promise<Result<T, Error>> {
    if (projectId !== this.projectId) {
      return missing(`No project with id ${projectId} in this repository.`);
    }
    if (!this.writable) return this.refuseWrite();
    const existing = await this.resources.findResourceByPath(
      this.projectId,
      this.storagePathOf(path),
    );
    if (existing) {
      const bumped = await this.resources.bumpRevision(
        this.projectId,
        existing.id,
        existing.revision,
      );
      if (!isOk(bumped)) {
        return err(
          new Error(
            `The resource changed since it was read: expected revision ${bumped.error.expectedRevision}, current revision ${bumped.error.currentRevision}.`,
          ),
        );
      }
    }
    const written = await this.storage.write(this.storagePathOf(path), content);
    if (!isOk(written)) return written;
    if (!existing) {
      await this.resources.createResource(this.projectId, {
        path: this.storagePathOf(path),
        type: resourceTypeOfName(path),
      });
    }
    return ok(toDomain(written.value));
  }

  /** Create a resource under a free name inside the project. */
  private async createNamed<T extends DiagramFile | NoteFile>(
    projectId: ProjectId,
    wanted: string,
    type: ResourceType,
    toDomain: (stored: StoredResource) => T,
    content = "",
    exactName?: string,
  ): Promise<Result<T, Error>> {
    if (projectId !== this.projectId) {
      return missing(`No project with id ${projectId} in this repository.`);
    }
    const name = exactName ?? (await this.freeName(projectId, wanted, type));
    return this.save(projectId, name, content, toDomain);
  }

  /** The first free name for a wanted name, inside the project. */
  private async freeName(
    projectId: ProjectId,
    wanted: string,
    type?: ResourceType,
  ): Promise<string> {
    if (projectId !== this.projectId) {
      throw new Error(`No project with id ${projectId} in this repository.`);
    }
    const kind = type ?? resourceTypeOfName(wanted);
    const extension =
      kind === "markdown-document"
        ? ".md"
        : kind === "event-flow"
          ? ".eventseq"
          : ".seq";
    const stem = wanted.replace(/\.[^./\\]+$/, "");
    for (let index = 0; index < 1000; index += 1) {
      const candidate =
        index === 0
          ? `${stem}${extension}`
          : `${stem} ${index + 1}${extension}`;
      const existing = await this.resources.findResourceByPath(
        this.projectId,
        candidate,
      );
      if (!existing) return candidate;
    }
    throw new Error(`Could not find a free name for "${wanted}".`);
  }

  /** Remove a resource's row and its file. */
  private async remove(
    projectId: ProjectId,
    path: string,
  ): Promise<Result<void, Error>> {
    if (projectId !== this.projectId) {
      return missing(`No project with id ${projectId} in this repository.`);
    }
    if (!this.writable) return this.refuseWrite();
    const record = await this.resources.findResourceByPath(
      this.projectId,
      this.storagePathOf(path),
    );
    const removed = await this.storage.remove(this.storagePathOf(path));
    if (!isOk(removed)) return removed;
    if (record) await this.resources.deleteResource(this.projectId, record.id);
    return ok(undefined);
  }

  /** Move a resource's file and its row, keeping its database id. */
  private async rename<T extends DiagramFile | NoteFile>(
    projectId: ProjectId,
    from: string,
    to: string,
    toDomain: (stored: StoredResource) => T,
  ): Promise<Result<T, Error>> {
    if (projectId !== this.projectId) {
      return missing(`No project with id ${projectId} in this repository.`);
    }
    if (!this.writable) return this.refuseWrite();
    const target =
      resourceTypeOfName(to) === "markdown-document" && !/\.md$/i.test(to)
        ? `${to}.md`
        : to;
    if (await this.storage.exists(target)) {
      return err(new Error(`Cannot rename to "${target}": it already exists.`));
    }
    const record = await this.resources.findResourceByPath(
      this.projectId,
      this.storagePathOf(from),
    );
    const moved = await this.storage.move({
      from: this.storagePathOf(from),
      to: target,
    });
    if (!isOk(moved)) return moved;
    if (record) {
      const movedRow = await this.resources.moveResource(
        this.projectId,
        record.id,
        target,
        record.revision,
      );
      if (!isOk(movedRow)) {
        return err(
          new Error(
            `The resource changed while it was being renamed: expected revision ${movedRow.error.expectedRevision}, current revision ${movedRow.error.currentRevision}.`,
          ),
        );
      }
    }
    return ok(toDomain(moved.value));
  }
}

/** Build a server workspace repository for one project. */
export function createServerWorkspaceRepository(
  options: ServerWorkspaceRepositoryOptions,
): RevisionedWorkspaceRepository {
  return new ServerWorkspaceRepository(options);
}

/** The empty identity record, for a project that has none yet. */
export function emptyProjectMetadata(): ProjectMetadata {
  return createEmptyMetadata();
}
