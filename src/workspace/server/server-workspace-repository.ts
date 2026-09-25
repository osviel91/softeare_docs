/**
 * A `WorkspaceRepository` over the server's HTTP API.
 *
 * This is the browser half of the mission's central claim: the editor depends on
 * a storage interface, and the *same* editor runs against IndexedDB or against an
 * authenticated server project. Nothing here parses DSL, validates a diagram or
 * decides who may write — those are the application layer's responsibilities and
 * they stay on the server. This class only translates:
 *
 * ```text
 * WorkspaceRepository (ids and files)  <->  /api/projects/:id/resources (rows and paths)
 * ```
 *
 * Three shape differences are worth naming, because hiding them badly is how an
 * adapter turns into a second implementation:
 *
 * - **Identity.** A local file's id *is* its path, so renaming it changes the id.
 *   A server resource has an opaque database id and a separate `path`, so a
 *   rename keeps the id and moves the path. The editor already tolerates both:
 *   `useWorkspace` follows a returned copy whose id may differ.
 * - **Concurrency.** Only the server has revisions. This adapter remembers the
 *   revision it last saw for each resource and sends it with every write, so a
 *   stale editor gets a {@link RevisionConflictError} instead of overwriting
 *   someone else's change. When the revision is not known — a fresh page, a file
 *   the adapter has never read — the resource is read once to learn it rather
 *   than writing blind.
 * - **Project identity.** The adapter is bound to one project at construction.
 *   That is what stops a component from addressing a project it was not handed:
 *   the project id never arrives from a click, only from an already-authorized
 *   listing. Creating and listing *projects* is the switcher's job, so those
 *   methods refuse here, exactly as the server-side repository does.
 */
import type {
  ProjectMetadata,
  SemanticMessageIdentity,
} from "../../domain/workspace/metadata";
import {
  PROJECT_METADATA_FORMAT,
  PROJECT_METADATA_VERSION,
} from "../../domain/workspace/metadata";
import { EMPTY_DIAGRAM_NAME } from "../../domain/workspace/diagram";
import { EMPTY_EVENT_FLOW_NAME } from "../../domain/workspace/event-flow";
import {
  EMPTY_NOTE_MARKDOWN,
  EMPTY_NOTE_NAME,
  ensureMarkdownExtension,
  uniqueNoteName,
} from "../../domain/workspace/note";
import { uniqueCopyName } from "../../domain/workspace/copy-name";
import { resourceTypeOfName } from "../../domain/workspace/resource-id";
import type {
  DiagramFile,
  NoteFile,
  Project,
  WorkspaceSnapshot,
} from "../../domain/workspace/types";
import type { ProjectId } from "../../domain/workspace/workspace-ids";
import { err, isOk, ok, type Result } from "../../shared/result/result";
import type { RevisionedWorkspaceRepository } from "../../application/ports";
import type { WorkspaceRepository } from "../WorkspaceRepository";
import { RevisionConflictError, ResourceNotFoundError } from "./api-errors";
import type {
  ServerApiClient,
  ServerResource,
  ServerResourceType,
} from "./api-client";

/** Options for {@link ServerWorkspaceRepository}. */
export interface ServerWorkspaceRepositoryOptions {
  /** The client every operation goes through. */
  client: ServerApiClient;
  /** The one project this repository addresses. */
  projectId: string;
  /** The project's display name, for the `Project` record. */
  projectName: string;
  /**
   * Whether the caller may change this project's resources.
   *
   * Resolved from `GET /api/projects/:id/access` before the repository is built,
   * so a viewer's editor is read-only in the UI *and* refused by the server. It
   * defaults to `false`: a caller that forgets to ask cannot accidentally hand a
   * read-only principal a writable repository.
   */
  writable?: boolean;
}

/** Turn a thrown value into the `Error` a `Result` carries. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A workspace repository for one authenticated server project.
 *
 * @see {@link RevisionedWorkspaceRepository} for why revisions are part of the
 *   shared contract rather than a server-only detail.
 */
export class ServerWorkspaceRepository
  implements RevisionedWorkspaceRepository, ForceWritableWorkspaceRepository
{
  private readonly client: ServerApiClient;
  private readonly projectId: string;
  private projectName: string;
  private readonly writable: boolean;
  /**
   * The revision this client last saw for each resource id.
   *
   * Deliberately per-instance and deliberately advisory: it is what makes the
   * *next* write able to say what it read. The server's conditional update is
   * still the authority, so a lost cache costs one extra read, never a wrong
   * write.
   */
  private readonly revisions = new Map<string, number>();

  constructor(options: ServerWorkspaceRepositoryOptions) {
    this.client = options.client;
    this.projectId = options.projectId;
    this.projectName = options.projectName;
    this.writable = options.writable ?? false;
  }

  /** The `Project` record this repository stands for. */
  private project(): Project {
    return { id: this.projectId, name: this.projectName, datasetIds: [] };
  }

  /** Refuse a write the caller's role does not carry. */
  private refuseWrite(): Result<never, Error> {
    return err(
      new Error(
        "This project is read-only for your account, so it cannot be changed.",
      ),
    );
  }

  /** Refuse an operation addressed at a different project. */
  private wrongProject(projectId: ProjectId): Result<never, Error> {
    return err(
      new Error(
        `This repository addresses project ${this.projectId}, not ${projectId}.`,
      ),
    );
  }

  // ---- Project lifecycle -----------------------------------------------------

  /** The one project this repository addresses, in storage order. */
  async listProjects(): Promise<Result<Project[], Error>> {
    return ok([this.project()]);
  }

  /** This project, or `null` for any other id. */
  async getProject(id: ProjectId): Promise<Result<Project | null, Error>> {
    return ok(id === this.projectId ? this.project() : null);
  }

  /**
   * Creating a project is the switcher's operation, not a repository write.
   *
   * A project-scoped repository has no honest answer to "create a project": it
   * would have to return a project it does not address. The browser's workspace
   * switcher calls the project endpoints directly and then opens the result.
   */
  async createProject(): Promise<Result<Project, Error>> {
    return err(
      new Error(
        "Creating a server project is not a repository write; use the server project list.",
      ),
    );
  }

  /** Rename this project. The id is the database id and never changes. */
  async renameProject(
    id: ProjectId,
    newName: string,
  ): Promise<Result<Project, Error>> {
    if (id !== this.projectId) return this.wrongProject(id);
    const name = newName.trim();
    if (name === "") return err(new Error("A project name is required."));
    try {
      const updated = await this.client.updateProject(this.projectId, { name });
      this.projectName = updated.name;
      return ok(this.project());
    } catch (error) {
      return err(toError(error));
    }
  }

  /** Delete this project and everything it holds. */
  async deleteProject(id: ProjectId): Promise<Result<void, Error>> {
    if (id !== this.projectId) return this.wrongProject(id);
    try {
      await this.client.deleteProject(this.projectId);
      return ok(undefined);
    } catch (error) {
      return err(toError(error));
    }
  }

  // ---- Identity record -------------------------------------------------------

  /**
   * The project's identity record, derived from the `resources` table.
   *
   * Server mode has no `project.json` sidecar: the database *is* the record, and
   * a second copy on the volume could only disagree with it. The shape is
   * synthesised here so the shared editor code — which understands identity as a
   * metadata document — sees the ids the server actually uses.
   */
  async readProjectMetadata(
    projectId: ProjectId,
  ): Promise<Result<ProjectMetadata | null, Error>> {
    if (projectId !== this.projectId) return this.wrongProject(projectId);
    try {
      const resources = await this.client.listResources(this.projectId);
      const relationships = await this.client.listResourceRelationships(this.projectId);
      let semanticMessages: SemanticMessageIdentity[] = [];
      if (typeof this.client.listSemanticMessages === "function") {
        try {
          semanticMessages = await this.client.listSemanticMessages(this.projectId);
        } catch (error) {
          if (!(error instanceof ResourceNotFoundError)) throw error;
        }
      }
      return ok({
        format: PROJECT_METADATA_FORMAT,
        version: PROJECT_METADATA_VERSION,
        resources: resources.map((resource) => ({
          id: resource.id,
          path: resource.path,
          type: resource.type,
        })),
        ...(relationships.length > 0 ? { relationships } : {}),
        ...(semanticMessages.length > 0 ? { semanticMessages } : {}),
      });
    } catch (error) {
      return err(toError(error));
    }
  }

  /**
   * A no-op, because the server owns resource identity.
   *
   * The shared editor reconciles a metadata document whenever its file list
   * changes. In server mode that reconciliation has nothing to persist — the
   * `resources` table already records each id and path, and letting the client
   * write a competing copy would be a second source of truth. Returning success
   * keeps the editor's flow intact without pretending the write happened.
   *
   * The `metadata` argument the interface passes is deliberately not accepted:
   * there is no honest destination for it, and dropping it here is clearer than
   * silently ignoring a value.
   */
  async writeProjectMetadata(
    projectId: ProjectId,
  ): Promise<Result<void, Error>> {
    if (projectId !== this.projectId) return this.wrongProject(projectId);
    return ok(undefined);
  }

  // ---- Diagrams and notes ----------------------------------------------------

  async listDiagramFiles(
    projectId: ProjectId,
  ): Promise<Result<DiagramFile[], Error>> {
    return this.listFiles(projectId, "diagram", (resource, content) =>
      this.toDiagram(resource, content),
    );
  }

  async listNoteFiles(
    projectId: ProjectId,
  ): Promise<Result<NoteFile[], Error>> {
    return this.listFiles(projectId, "note", (resource, content) =>
      this.toNote(resource, content),
    );
  }

  async getDiagramFile(
    projectId: ProjectId,
    diagramId: string,
  ): Promise<Result<DiagramFile | null, Error>> {
    const read = await this.readOne(projectId, diagramId);
    if (!isOk(read)) return read;
    if (read.value === null) return ok(null);
    if (read.value.resource.type === "markdown-document") return ok(null);
    return ok(this.toDiagram(read.value.resource, read.value.content));
  }

  async getNoteFile(
    projectId: ProjectId,
    noteId: string,
  ): Promise<Result<NoteFile | null, Error>> {
    const read = await this.readOne(projectId, noteId);
    if (!isOk(read)) return read;
    if (read.value === null) return ok(null);
    if (read.value.resource.type !== "markdown-document") return ok(null);
    return ok(this.toNote(read.value.resource, read.value.content));
  }

  async saveDiagramFile(
    projectId: ProjectId,
    diagram: DiagramFile,
  ): Promise<Result<DiagramFile, Error>> {
    return this.save(
      projectId,
      diagram.id,
      diagram.name,
      diagram.source,
      diagram.metadata,
      resourceTypeOfName(diagram.name) === "event-flow"
        ? "event-flow"
        : "sequence-diagram",
      (resource, content) => this.toDiagram(resource, content),
    );
  }

  async saveNoteFile(
    projectId: ProjectId,
    note: NoteFile,
  ): Promise<Result<NoteFile, Error>> {
    return this.save(
      projectId,
      note.id,
      ensureMarkdownExtension(note.name),
      note.markdown,
      note.metadata,
      "markdown-document",
      (resource, content) => this.toNote(resource, content),
    );
  }

  async createEmptyDiagram(
    projectId: ProjectId,
  ): Promise<Result<DiagramFile, Error>> {
    return this.create(
      projectId,
      "sequence-diagram",
      EMPTY_DIAGRAM_NAME,
      "",
      (r, c) => this.toDiagram(r, c),
    );
  }

  /**
   * Overwrite a diagram at a revision the caller names (the conflict dialog).
   *
   * @see ForceWritableWorkspaceRepository for why this is a separate method.
   */
  async forceSaveDiagramFile(
    projectId: ProjectId,
    diagram: DiagramFile,
    expectedRevision: number,
  ): Promise<Result<DiagramFile, Error>> {
    return this.forceSave(
      projectId,
      diagram.id,
      diagram.source,
      expectedRevision,
      diagram.metadata,
      (resource, content) => this.toDiagram(resource, content),
    );
  }

  /** Overwrite a note at a revision the caller names. */
  async forceSaveNoteFile(
    projectId: ProjectId,
    note: NoteFile,
    expectedRevision: number,
  ): Promise<Result<NoteFile, Error>> {
    return this.forceSave(
      projectId,
      note.id,
      note.markdown,
      expectedRevision,
      note.metadata,
      (resource, content) => this.toNote(resource, content),
    );
  }

  async createEmptyEventFlow(
    projectId: ProjectId,
  ): Promise<Result<DiagramFile, Error>> {
    return this.create(
      projectId,
      "event-flow",
      EMPTY_EVENT_FLOW_NAME,
      "",
      (r, c) => this.toDiagram(r, c),
    );
  }

  async createEmptyNote(
    projectId: ProjectId,
  ): Promise<Result<NoteFile, Error>> {
    return this.create(
      projectId,
      "markdown-document",
      EMPTY_NOTE_NAME,
      EMPTY_NOTE_MARKDOWN,
      (r, c) => this.toNote(r, c),
    );
  }

  async duplicateDiagramFile(
    projectId: ProjectId,
    diagramId: string,
  ): Promise<Result<DiagramFile, Error>> {
    const read = await this.getDiagramFile(projectId, diagramId);
    if (!isOk(read)) return read;
    if (read.value === null) {
      return err(new Error(`No diagram with id ${diagramId}.`));
    }
    return this.create(
      projectId,
      resourceTypeOfName(read.value.name) === "event-flow"
        ? "event-flow"
        : "sequence-diagram",
      read.value.name,
      read.value.source,
      (r, c) => this.toDiagram(r, c),
      read.value.name,
    );
  }

  async duplicateNoteFile(
    projectId: ProjectId,
    noteId: string,
  ): Promise<Result<NoteFile, Error>> {
    const read = await this.getNoteFile(projectId, noteId);
    if (!isOk(read)) return read;
    if (read.value === null)
      return err(new Error(`No note with id ${noteId}.`));
    return this.create(
      projectId,
      "markdown-document",
      read.value.name,
      read.value.markdown,
      (r, c) => this.toNote(r, c),
      read.value.name,
    );
  }

  async deleteDiagramFile(
    projectId: ProjectId,
    diagramId: string,
  ): Promise<Result<void, Error>> {
    return this.remove(projectId, diagramId);
  }
  async deleteNoteFile(
    projectId: ProjectId,
    noteId: string,
  ): Promise<Result<void, Error>> {
    return this.remove(projectId, noteId);
  }

  async renameDiagramFile(
    projectId: ProjectId,
    diagramId: string,
    newName: string,
  ): Promise<Result<DiagramFile, Error>> {
    return this.rename(projectId, diagramId, newName, (r, c) =>
      this.toDiagram(r, c),
    );
  }

  async renameNoteFile(
    projectId: ProjectId,
    noteId: string,
    newName: string,
  ): Promise<Result<NoteFile, Error>> {
    const target = ensureMarkdownExtension(newName);
    return this.rename(projectId, noteId, target, (r, c) => this.toNote(r, c));
  }

  // ---- Snapshot and revisions ------------------------------------------------

  async listAll(): Promise<Result<WorkspaceSnapshot, Error>> {
    const [diagrams, notes] = await Promise.all([
      this.listDiagramFiles(this.projectId),
      this.listNoteFiles(this.projectId),
    ]);
    if (!isOk(diagrams)) return diagrams;
    if (!isOk(notes)) return notes;
    return ok({
      projects: [this.project()],
      diagrams: diagrams.value,
      notes: notes.value,
    });
  }

  /** The revision this client last saw at a path, or `null` when unknown. */
  async revisionOf(
    projectId: ProjectId,
    path: string,
  ): Promise<Result<number | null, Error>> {
    if (projectId !== this.projectId) return this.wrongProject(projectId);
    const resource = await this.findByPath(path);
    if (!isOk(resource)) return resource;
    return ok(resource.value?.revision ?? null);
  }

  /** Refuse a write whose expectation no longer matches the server's. */
  async expectRevision(
    projectId: ProjectId,
    path: string,
    expectedRevision: number,
  ): Promise<Result<void, Error>> {
    if (projectId !== this.projectId) return this.wrongProject(projectId);
    const resource = await this.findByPath(path);
    if (!isOk(resource)) return resource;
    if (resource.value === null) {
      return err(new Error(`Nothing is stored at "${path}".`));
    }
    if (resource.value.revision !== expectedRevision) {
      return err(
        new RevisionConflictError(
          `The resource changed since it was read: expected revision ${expectedRevision}, current revision ${resource.value.revision}.`,
          {
            expectedRevision,
            currentRevision: resource.value.revision,
          },
        ),
      );
    }
    return ok(undefined);
  }

  // ---- Internals -------------------------------------------------------------

  /** Read a stored resource into the shared diagram/note shape. */
  private toDiagram(resource: ServerResource, content: string): DiagramFile {
    return {
      id: resource.id,
      name: resource.path,
      source: content,
      projectId: this.projectId,
      metadata: resource.metadata,
    };
  }

  private toNote(resource: ServerResource, content: string): NoteFile {
    return {
      id: resource.id,
      name: resource.path,
      markdown: content,
      projectId: this.projectId,
      metadata: resource.metadata,
    };
  }

  /** Remember the revision a response carried, so the next write can name it. */
  private remember(resource: ServerResource): void {
    this.revisions.set(resource.id, resource.revision);
  }

  /** List one kind of file, reading each resource's text. */
  private async listFiles<T>(
    projectId: ProjectId,
    kind: "diagram" | "note",
    toDomain: (resource: ServerResource, content: string) => T,
  ): Promise<Result<T[], Error>> {
    if (projectId !== this.projectId) return this.wrongProject(projectId);
    try {
      const resources = await this.client.listResources(this.projectId);
      const wanted = resources.filter((resource) =>
        kind === "note"
          ? resource.type === "markdown-document"
          : resource.type !== "markdown-document",
      );
      const files: T[] = [];
      for (const resource of wanted) {
        const read = await this.client.readResource(
          this.projectId,
          resource.id,
        );
        this.remember(read.resource);
        files.push(toDomain(read.resource, read.content));
      }
      return ok(files);
    } catch (error) {
      return err(toError(error));
    }
  }

  /** Read one resource, mapping "absent" onto `null` rather than an error. */
  private async readOne(
    projectId: ProjectId,
    resourceId: string,
  ): Promise<
    Result<{ resource: ServerResource; content: string } | null, Error>
  > {
    if (projectId !== this.projectId) return this.wrongProject(projectId);
    try {
      const read = await this.client.readResource(this.projectId, resourceId);
      this.remember(read.resource);
      return ok(read);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) return ok(null);
      return err(toError(error));
    }
  }

  /** Find a resource by its path, listing once when it is not already known. */
  private async findByPath(
    path: string,
  ): Promise<Result<ServerResource | null, Error>> {
    try {
      const resources = await this.client.listResources(this.projectId);
      return ok(resources.find((resource) => resource.path === path) ?? null);
    } catch (error) {
      return err(toError(error));
    }
  }

  /**
   * Write a file's content, creating it when the client has never read it.
   *
   * The revision is what decides: a resource this client has seen is updated
   * with the revision it saw, and one it has not is looked up by path first. That
   * lookup is what keeps a reloaded page — which has ids but no cache — from
   * silently creating a duplicate beside an existing file.
   */
  private async save<T>(
    projectId: ProjectId,
    id: string,
    path: string,
    content: string,
    metadata: DiagramFile["metadata"],
    type: ServerResourceType,
    toDomain: (resource: ServerResource, content: string) => T,
  ): Promise<Result<T, Error>> {
    if (projectId !== this.projectId) return this.wrongProject(projectId);
    if (!this.writable) return this.refuseWrite();
    try {
      const known = this.revisions.get(id);
      if (known !== undefined) {
        const updated = await this.client.updateResource(this.projectId, id, {
          content,
          expectedRevision: known,
          metadata,
        });
        this.remember(updated);
        return ok(toDomain(updated, content));
      }

      const existing = await this.findByPath(path);
      if (!isOk(existing)) return existing;
      if (existing.value !== null) {
        const updated = await this.client.updateResource(
          this.projectId,
          existing.value.id,
          { content, expectedRevision: existing.value.revision, metadata },
        );
        this.remember(updated);
        return ok(toDomain(updated, content));
      }

      const created = await this.client.createResource(this.projectId, {
        path,
        type,
        content,
        metadata,
      });
      this.remember(created);
      return ok(toDomain(created, content));
    } catch (error) {
      return err(toError(error));
    }
  }

  /**
   * Overwrite a resource at an explicitly named revision.
   *
   * The revision comes from the `409` the server just returned, so the caller is
   * the conflict dialog acting on the user's confirmation — never a normal save.
   * The write is still conditional: if someone writes again between the conflict
   * and the confirmation, this fails with a fresh conflict rather than clobbering
   * that newer change.
   */
  private async forceSave<T>(
    projectId: ProjectId,
    resourceId: string,
    content: string,
    expectedRevision: number,
    metadata: DiagramFile["metadata"],
    toDomain: (resource: ServerResource, content: string) => T,
  ): Promise<Result<T, Error>> {
    if (projectId !== this.projectId) return this.wrongProject(projectId);
    if (!this.writable) return this.refuseWrite();
    try {
      const updated = await this.client.updateResource(
        this.projectId,
        resourceId,
        { content, expectedRevision, metadata },
      );
      this.remember(updated);
      return ok(toDomain(updated, content));
    } catch (error) {
      return err(toError(error));
    }
  }

  /**
   * Create a file under a free name.
   *
   * The name is chosen from the project's current resource paths, but the server
   * remains the authority: if another writer took the name between the listing
   * and the write, the create is refused and the caller sees a conflict rather
   * than a clobbered document.
   */
  private async create<T>(
    projectId: ProjectId,
    type: ServerResourceType,
    wanted: string,
    content: string,
    toDomain: (resource: ServerResource, content: string) => T,
    sourceName?: string,
  ): Promise<Result<T, Error>> {
    if (projectId !== this.projectId) return this.wrongProject(projectId);
    if (!this.writable) return this.refuseWrite();
    try {
      const resources = await this.client.listResources(this.projectId);
      const paths = resources.map((resource) => resource.path);
      const name =
        sourceName === undefined
          ? freeName(wanted, type, paths)
          : uniqueCopyName(sourceName, paths);
      const created = await this.client.createResource(this.projectId, {
        path: name,
        type,
        content,
      });
      this.remember(created);
      return ok(toDomain(created, content));
    } catch (error) {
      return err(toError(error));
    }
  }

  /** Delete a resource, refusing a stale address the server does not know. */
  private async remove(
    projectId: ProjectId,
    resourceId: string,
  ): Promise<Result<void, Error>> {
    if (projectId !== this.projectId) return this.wrongProject(projectId);
    if (!this.writable) return this.refuseWrite();
    try {
      await this.client.deleteResource(this.projectId, resourceId);
      this.revisions.delete(resourceId);
      return ok(undefined);
    } catch (error) {
      return err(toError(error));
    }
  }

  /** Move a resource's path, keeping its id. */
  private async rename<T>(
    projectId: ProjectId,
    resourceId: string,
    newName: string,
    toDomain: (resource: ServerResource, content: string) => T,
  ): Promise<Result<T, Error>> {
    if (projectId !== this.projectId) return this.wrongProject(projectId);
    if (!this.writable) return this.refuseWrite();
    const target = newName.trim();
    if (target === "") return err(new Error("A file name is required."));
    try {
      const read = await this.client.readResource(this.projectId, resourceId);
      this.remember(read.resource);
      const moved = await this.client.moveResource(this.projectId, resourceId, {
        path: target,
        expectedRevision: read.resource.revision,
      });
      this.remember(moved);
      return ok(toDomain(moved, read.content));
    } catch (error) {
      return err(toError(error));
    }
  }
}

/**
 * The first free path for a wanted name, given the paths already in use.
 *
 * Mirrors the naming rules the local repositories use (`Untitled`, `Untitled 2`,
 * …) but adds the extension the server's file paths carry, so a document created
 * in the browser and one created by an agent over MCP look the same on the
 * volume.
 */
function freeName(
  wanted: string,
  type: ServerResourceType,
  existing: readonly string[],
): string {
  const bare = wanted.replace(/\.[^./\\]+$/, "");
  const taken = new Set(existing);
  if (type === "markdown-document") {
    return uniqueNoteName([...existing]);
  }
  if (type === "event-flow") {
    const stem = bare === "" ? "Untitled" : bare;
    const first = `${stem}.eventseq`;
    if (!taken.has(first)) return first;
    let index = 2;
    while (taken.has(`${stem} ${index}.eventseq`)) index += 1;
    return `${stem} ${index}.eventseq`;
  }
  const stem = bare === "" ? EMPTY_DIAGRAM_NAME : bare;
  const first = `${stem}.seq`;
  if (!taken.has(first)) return first;
  let index = 2;
  while (taken.has(`${stem} ${index}.seq`)) index += 1;
  return `${stem} ${index}.seq`;
}

/** Build a repository for one authenticated server project. */
export function createServerWorkspaceRepository(
  options: ServerWorkspaceRepositoryOptions,
): ServerWorkspaceRepository {
  return new ServerWorkspaceRepository(options);
}

/**
 * A repository that can overwrite a resource at a revision the caller names.
 *
 * This exists for exactly one caller: the conflict dialog's "keep my changes".
 * A normal save must never be able to bypass the revision check, so the
 * capability is a separate, explicit interface that only the server adapter
 * implements — and the caller has to have been told about the conflict, because
 * the revision it passes comes from the `409` the server just returned.
 *
 * @see {@link ServerWorkspaceRepository.forceSaveDiagramFile}
 */
export interface ForceWritableWorkspaceRepository extends WorkspaceRepository {
  /**
   * Replace a resource's content, expecting the revision the server reports.
   *
   * A stale `expectedRevision` still fails: the point is not to disable
   * concurrency control but to let a user who has *seen* the conflict confirm an
   * overwrite. If someone writes again in between, the dialog reappears.
   */
  forceSaveDiagramFile(
    projectId: ProjectId,
    diagram: DiagramFile,
    expectedRevision: number,
  ): Promise<Result<DiagramFile, Error>>;

  /** @see forceSaveDiagramFile */
  forceSaveNoteFile(
    projectId: ProjectId,
    note: NoteFile,
    expectedRevision: number,
  ): Promise<Result<NoteFile, Error>>;
}

/** Whether a repository supports a user-confirmed overwrite. */
export function supportsForcedWrite(
  repo: WorkspaceRepository,
): repo is ForceWritableWorkspaceRepository {
  const candidate = repo as Partial<ForceWritableWorkspaceRepository>;
  return (
    typeof candidate.forceSaveDiagramFile === "function" &&
    typeof candidate.forceSaveNoteFile === "function"
  );
}
