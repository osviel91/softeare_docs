/**
 * In-memory {@link WorkspaceRepository}.
 *
 * Holds projects, diagrams, and notes in plain Maps with no persistence. It
 * serves two purposes: a fallback when IndexedDB is unavailable (so the app still
 * renders in jsdom and in browsers without IndexedDB), and a deterministic, fast
 * repository for tests that want repository-level behavior without an in-memory
 * {@link IdbFactory}.
 *
 * It upholds the same invariants as the IndexedDB implementation: a diagram or
 * note belongs to exactly one project, `Project.datasetIds` / `Project.noteIds`
 * stay in sync, and deleting a project removes both kinds of file.
 */
import type { ProjectMetadata } from "../domain/workspace/metadata";
import { normalizeResourceMetadata } from "../domain/workspace/resource-metadata";
import type {
  DiagramFile,
  NoteFile,
  Project,
  WorkspaceSnapshot,
} from "../domain/workspace/types";
import { newDiagramFileId, newNoteId } from "../domain/workspace/workspace-ids";
import type { ProjectId } from "../domain/workspace/workspace-ids";
import { EMPTY_NOTE_MARKDOWN, uniqueNoteName } from "../domain/workspace/note";
import { uniqueCopyName } from "../domain/workspace/copy-name";
import { uniqueDiagramName } from "../domain/workspace/diagram";
import { uniqueEventFlowName } from "../domain/workspace/event-flow";
import { err, ok, type Result } from "../shared/result/result";
import type { WorkspaceRepository } from "./WorkspaceRepository";

/** Turn any unexpected error into a plain, serializable Error. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Copy a metadata document so the store never shares mutable state with a
 * caller. The document is one small record per file, so copying it wholesale is
 * cheap and removes any chance of an aliasing bug.
 */
function copyMetadata(metadata: ProjectMetadata): ProjectMetadata {
  return {
    ...metadata,
    resources: metadata.resources.map((resource) => ({ ...resource })),
  };
}

/** Build an empty in-memory repository. */
export function createInMemoryWorkspaceRepository(): WorkspaceRepository {
  const projects = new Map<string, Project>();
  const diagrams = new Map<string, DiagramFile>();
  const notes = new Map<string, NoteFile>();
  const metadataByProject = new Map<string, ProjectMetadata>();

  /** Append an id to one of a project's ordered id lists. */
  function link(
    projectId: ProjectId,
    field: "datasetIds" | "noteIds",
    id: string,
  ): void {
    const project = projects.get(projectId);
    if (!project) return;
    const current = project[field] ?? [];
    if (!current.includes(id)) {
      projects.set(projectId, { ...project, [field]: [...current, id] });
    }
  }

  /** Remove an id from one of a project's ordered id lists. */
  function unlink(
    projectId: ProjectId,
    field: "datasetIds" | "noteIds",
    id: string,
  ): void {
    const project = projects.get(projectId);
    if (!project) return;
    const current = project[field] ?? [];
    projects.set(projectId, {
      ...project,
      [field]: current.filter((entry) => entry !== id),
    });
  }

  return {
    async listProjects(): Promise<Result<Project[], Error>> {
      try {
        return ok([...projects.values()]);
      } catch (error) {
        return err(toError(error));
      }
    },

    async getProject(id: ProjectId): Promise<Result<Project | null, Error>> {
      try {
        return ok(projects.get(id) ?? null);
      } catch (error) {
        return err(toError(error));
      }
    },

    async createProject(name: string): Promise<Result<Project, Error>> {
      try {
        // In-memory ids only need to be unique within the run.
        const project: Project = {
          id: `proj-${projects.size}-${name}`,
          name,
          datasetIds: [],
          noteIds: [],
        };
        projects.set(project.id, project);
        return ok(project);
      } catch (error) {
        return err(toError(error));
      }
    },

    async renameProject(
      id: ProjectId,
      newName: string,
    ): Promise<Result<Project, Error>> {
      try {
        const project = projects.get(id);
        if (!project) return err(new Error(`Unknown project: ${id}`));
        const name = newName.trim();
        if (name === "") return err(new Error("A project name is required"));
        // The id is independent of the name here, so nothing else moves.
        const renamed: Project = { ...project, name };
        projects.set(id, renamed);
        return ok(renamed);
      } catch (error) {
        return err(toError(error));
      }
    },

    async deleteProject(id: ProjectId): Promise<Result<void, Error>> {
      try {
        const project = projects.get(id);
        if (project) {
          for (const diagramId of project.datasetIds)
            diagrams.delete(diagramId);
          for (const noteId of project.noteIds ?? []) notes.delete(noteId);
        }
        projects.delete(id);
        metadataByProject.delete(id);
        return ok(undefined);
      } catch (error) {
        return err(toError(error));
      }
    },

    async readProjectMetadata(
      projectId: ProjectId,
    ): Promise<Result<ProjectMetadata | null, Error>> {
      try {
        const stored = metadataByProject.get(projectId);
        return ok(stored ? copyMetadata(stored) : null);
      } catch (error) {
        return err(toError(error));
      }
    },

    async writeProjectMetadata(
      projectId: ProjectId,
      metadata: ProjectMetadata,
    ): Promise<Result<void, Error>> {
      try {
        if (!projects.has(projectId)) {
          return err(new Error(`Unknown project: ${projectId}`));
        }
        metadataByProject.set(projectId, copyMetadata(metadata));
        return ok(undefined);
      } catch (error) {
        return err(toError(error));
      }
    },

    async listDiagramFiles(
      projectId: ProjectId,
    ): Promise<Result<DiagramFile[], Error>> {
      try {
        const project = projects.get(projectId);
        if (!project) return ok([]);
        return ok(
          project.datasetIds
            .map((did) => diagrams.get(did))
            .filter((diagram): diagram is DiagramFile => diagram !== undefined),
        );
      } catch (error) {
        return err(toError(error));
      }
    },

    async getDiagramFile(
      projectId: ProjectId,
      diagramId: string,
    ): Promise<Result<DiagramFile | null, Error>> {
      try {
        const diagram = diagrams.get(diagramId);
        if (!diagram || diagram.projectId !== projectId) return ok(null);
        return ok(diagram);
      } catch (error) {
        return err(toError(error));
      }
    },

    async saveDiagramFile(
      projectId: ProjectId,
      diagram: DiagramFile,
    ): Promise<Result<DiagramFile, Error>> {
      try {
        const stored: DiagramFile = {
          ...diagram,
          projectId,
          ...(diagram.metadata === undefined
            ? {}
            : { metadata: normalizeResourceMetadata(diagram.metadata) }),
        };
        diagrams.set(diagram.id, stored);
        link(projectId, "datasetIds", diagram.id);
        return ok(stored);
      } catch (error) {
        return err(toError(error));
      }
    },

    async createEmptyDiagram(
      projectId: ProjectId,
    ): Promise<Result<DiagramFile, Error>> {
      try {
        const project = projects.get(projectId);
        if (!project) return err(new Error(`Unknown project: ${projectId}`));
        const name = uniqueDiagramName(
          project.datasetIds
            .map((did) => diagrams.get(did)?.name)
            .filter((value): value is string => typeof value === "string"),
        );
        const id = newDiagramFileId();
        const diagram: DiagramFile = {
          id,
          name,
          source: "",
          projectId,
        };
        diagrams.set(id, diagram);
        link(projectId, "datasetIds", id);
        return ok(diagram);
      } catch (error) {
        return err(toError(error));
      }
    },

    async createEmptyEventFlow(
      projectId: ProjectId,
    ): Promise<Result<DiagramFile, Error>> {
      try {
        const project = projects.get(projectId);
        if (!project) return err(new Error(`Unknown project: ${projectId}`));
        const name = uniqueEventFlowName(
          project.datasetIds
            .map((did) => diagrams.get(did)?.name)
            .filter((value): value is string => typeof value === "string"),
        );
        const id = newDiagramFileId();
        const flow: DiagramFile = { id, name, source: "", projectId };
        diagrams.set(id, flow);
        link(projectId, "datasetIds", id);
        return ok(flow);
      } catch (error) {
        return err(toError(error));
      }
    },

    async duplicateDiagramFile(
      projectId: ProjectId,
      diagramId: string,
    ): Promise<Result<DiagramFile, Error>> {
      try {
        const source = diagrams.get(diagramId);
        if (!source || source.projectId !== projectId) {
          return err(new Error(`Unknown diagram: ${diagramId}`));
        }
        const siblings = [...diagrams.values()].filter(
          (other) => other.projectId === projectId,
        );
        const copy: DiagramFile = {
          ...source,
          id: newDiagramFileId(),
          name: uniqueCopyName(
            source.name,
            siblings.map((other) => other.name),
          ),
        };
        diagrams.set(copy.id, copy);
        link(projectId, "datasetIds", copy.id);
        return ok(copy);
      } catch (error) {
        return err(toError(error));
      }
    },

    async deleteDiagramFile(
      projectId: ProjectId,
      diagramId: string,
    ): Promise<Result<void, Error>> {
      try {
        diagrams.delete(diagramId);
        unlink(projectId, "datasetIds", diagramId);
        return ok(undefined);
      } catch (error) {
        return err(toError(error));
      }
    },

    async renameDiagramFile(
      projectId: ProjectId,
      diagramId: string,
      newName: string,
    ): Promise<Result<DiagramFile, Error>> {
      try {
        const diagram = diagrams.get(diagramId);
        if (!diagram || diagram.projectId !== projectId) {
          return err(new Error(`Unknown diagram: ${diagramId}`));
        }
        const name = newName.trim();
        if (name === "") return err(new Error("A diagram name is required"));
        const clash = [...diagrams.values()].some(
          (other) =>
            other.projectId === projectId &&
            other.id !== diagramId &&
            other.name === name,
        );
        if (clash) {
          return err(new Error(`A diagram named "${name}" already exists`));
        }
        const renamed: DiagramFile = { ...diagram, name };
        diagrams.set(diagramId, renamed);
        return ok(renamed);
      } catch (error) {
        return err(toError(error));
      }
    },

    async listNoteFiles(
      projectId: ProjectId,
    ): Promise<Result<NoteFile[], Error>> {
      try {
        const project = projects.get(projectId);
        if (!project) return ok([]);
        return ok(
          (project.noteIds ?? [])
            .map((nid) => notes.get(nid))
            .filter((note): note is NoteFile => note !== undefined),
        );
      } catch (error) {
        return err(toError(error));
      }
    },

    async getNoteFile(
      projectId: ProjectId,
      noteId: string,
    ): Promise<Result<NoteFile | null, Error>> {
      try {
        const note = notes.get(noteId);
        if (!note || note.projectId !== projectId) return ok(null);
        return ok(note);
      } catch (error) {
        return err(toError(error));
      }
    },

    async saveNoteFile(
      projectId: ProjectId,
      note: NoteFile,
    ): Promise<Result<NoteFile, Error>> {
      try {
        const stored: NoteFile = {
          ...note,
          projectId,
          ...(note.metadata === undefined
            ? {}
            : { metadata: normalizeResourceMetadata(note.metadata) }),
        };
        notes.set(note.id, stored);
        link(projectId, "noteIds", note.id);
        return ok(stored);
      } catch (error) {
        return err(toError(error));
      }
    },

    async createEmptyNote(
      projectId: ProjectId,
    ): Promise<Result<NoteFile, Error>> {
      try {
        const project = projects.get(projectId);
        if (!project) return err(new Error(`Unknown project: ${projectId}`));
        const name = uniqueNoteName(
          (project.noteIds ?? [])
            .map((nid) => notes.get(nid)?.name)
            .filter((value): value is string => typeof value === "string"),
        );
        const note: NoteFile = {
          id: newNoteId(),
          name,
          markdown: EMPTY_NOTE_MARKDOWN,
          projectId,
        };
        notes.set(note.id, note);
        link(projectId, "noteIds", note.id);
        return ok(note);
      } catch (error) {
        return err(toError(error));
      }
    },

    async duplicateNoteFile(
      projectId: ProjectId,
      noteId: string,
    ): Promise<Result<NoteFile, Error>> {
      try {
        const source = notes.get(noteId);
        if (!source || source.projectId !== projectId) {
          return err(new Error(`Unknown note: ${noteId}`));
        }
        const siblings = [...notes.values()].filter(
          (other) => other.projectId === projectId,
        );
        const copy: NoteFile = {
          ...source,
          id: newNoteId(),
          name: uniqueCopyName(
            source.name,
            siblings.map((other) => other.name),
          ),
        };
        notes.set(copy.id, copy);
        link(projectId, "noteIds", copy.id);
        return ok(copy);
      } catch (error) {
        return err(toError(error));
      }
    },

    async deleteNoteFile(
      projectId: ProjectId,
      noteId: string,
    ): Promise<Result<void, Error>> {
      try {
        notes.delete(noteId);
        unlink(projectId, "noteIds", noteId);
        return ok(undefined);
      } catch (error) {
        return err(toError(error));
      }
    },

    async renameNoteFile(
      projectId: ProjectId,
      noteId: string,
      newName: string,
    ): Promise<Result<NoteFile, Error>> {
      try {
        const note = notes.get(noteId);
        if (!note || note.projectId !== projectId) {
          return err(new Error(`Unknown note: ${noteId}`));
        }
        const name = newName.trim();
        if (name === "") return err(new Error("A note name is required"));
        const clash = [...notes.values()].some(
          (other) =>
            other.projectId === projectId &&
            other.id !== noteId &&
            other.name === name,
        );
        if (clash) {
          return err(new Error(`A note named "${name}" already exists`));
        }
        const renamed: NoteFile = { ...note, name };
        notes.set(noteId, renamed);
        return ok(renamed);
      } catch (error) {
        return err(toError(error));
      }
    },

    async listAll(): Promise<Result<WorkspaceSnapshot, Error>> {
      try {
        return ok({
          projects: [...projects.values()],
          diagrams: [...diagrams.values()],
          notes: [...notes.values()],
        });
      } catch (error) {
        return err(toError(error));
      }
    },
  };
}
