/**
 * In-memory {@link WorkspaceRepository} (Phase 4).
 *
 * Holds projects and diagrams in plain Maps with no persistence. It serves two
 * purposes: a fallback when IndexedDB is unavailable (so the app still renders in
 * jsdom and in browsers without IndexedDB), and a deterministic, fast repository
 * for tests that want repository-level behavior without an in-memory {@link IdbFactory}.
 *
 * It upholds the same invariants as the IndexedDB implementation: a diagram
 * belongs to exactly one project, `Project.datasetIds` stays in sync, and deleting
 * a project removes its diagrams.
 */
import type {
  DiagramFile,
  Project,
  WorkspaceSnapshot,
} from "../domain/workspace/types";
import { newDiagramFileId } from "../domain/workspace/workspace-ids";
import type { ProjectId } from "../domain/workspace/workspace-ids";
import { err, ok, type Result } from "../shared/result/result";
import type { WorkspaceRepository } from "./WorkspaceRepository";

/** Build an empty in-memory repository. */
export function createInMemoryWorkspaceRepository(): WorkspaceRepository {
  const projects = new Map<string, Project>();
  const diagrams = new Map<string, DiagramFile>();

  return {
    async listProjects(): Promise<Result<Project[], Error>> {
      try {
        return ok([...projects.values()]);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async getProject(id: ProjectId): Promise<Result<Project | null, Error>> {
      try {
        return ok(projects.get(id) ?? null);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async createProject(name: string): Promise<Result<Project, Error>> {
      try {
        // In-memory ids only need to be unique within the run.
        const project: Project = {
          id: `proj-${projects.size}-${name}`,
          name,
          datasetIds: [],
        };
        projects.set(project.id, project);
        return ok(project);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async deleteProject(id: ProjectId): Promise<Result<void, Error>> {
      try {
        const project = projects.get(id);
        if (project) {
          for (const diagramId of project.datasetIds) {
            diagrams.delete(diagramId);
          }
        }
        projects.delete(id);
        return ok(undefined);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
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
        return err(error instanceof Error ? error : new Error(String(error)));
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
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async saveDiagramFile(
      projectId: ProjectId,
      diagram: DiagramFile,
    ): Promise<Result<DiagramFile, Error>> {
      try {
        const stored: DiagramFile = { ...diagram, projectId };
        diagrams.set(diagram.id, stored);
        const project = projects.get(projectId);
        if (project && !project.datasetIds.includes(diagram.id)) {
          projects.set(projectId, {
            ...project,
            datasetIds: [...project.datasetIds, diagram.id],
          });
        }
        return ok(stored);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async createEmptyDiagram(
      projectId: ProjectId,
    ): Promise<Result<DiagramFile, Error>> {
      try {
        const project = projects.get(projectId);
        if (!project) return err(new Error(`Unknown project: ${projectId}`));
        // A fresh id keeps the file unique; "Untitled" is a placeholder name the
        // user can later distinguish once a rename feature exists.
        const id = newDiagramFileId();
        const diagram: DiagramFile = {
          id,
          name: "Untitled",
          source: "",
          projectId,
        };
        diagrams.set(id, diagram);
        projects.set(projectId, {
          ...project,
          datasetIds: [...project.datasetIds, id],
        });
        return ok(diagram);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async deleteDiagramFile(
      projectId: ProjectId,
      diagramId: string,
    ): Promise<Result<void, Error>> {
      try {
        diagrams.delete(diagramId);
        const project = projects.get(projectId);
        if (project) {
          projects.set(projectId, {
            ...project,
            datasetIds: project.datasetIds.filter((did) => did !== diagramId),
          });
        }
        return ok(undefined);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async listAll(): Promise<Result<WorkspaceSnapshot, Error>> {
      try {
        return ok({
          projects: [...projects.values()],
          diagrams: [...diagrams.values()],
        });
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
