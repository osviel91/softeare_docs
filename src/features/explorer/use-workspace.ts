/**
 * Workspace state hook (Phase 4).
 *
 * `useWorkspace` owns everything the explorer and editor share: the list of
 * projects, the diagrams of the selected project, the currently loaded diagram
 * source, and the async actions that mutate IndexedDB. App feeds the resulting
 * `source` to the editor and preview, so selecting a diagram or editing it both
 * flow through this single hook instead of scattering state across panes.
 *
 * The initial source is seeded with a valid sample diagram so the editor and
 * preview are populated synchronously on first render — before the async load
 * resolves. If the repository holds real projects, the load replaces the seed;
 * otherwise the sample remains as a convenient starting point.
 */
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { DiagramFile, Project } from "../../domain/workspace/types";
import type { Result } from "../../shared/result/result";
import { isOk } from "../../shared/result/result";
import type { WorkspaceRepository } from "../../workspace/WorkspaceRepository";
import { SAMPLE_SOURCE } from "../../sample-source";

/** The state and actions exposed by {@link useWorkspace}. */
export interface WorkspaceHook {
  /** Every project, in storage order. */
  projects: Project[];
  /** Diagram files of the selected project, in display order. */
  diagrams: DiagramFile[];
  /** The id of the selected project, or `null` when none is selected. */
  selectedProjectId: string | null;
  /** The id of the loaded diagram, or `null` when none is loaded. */
  selectedDiagramId: string | null;
  /**
   * The loaded diagram file, or `null` when none is loaded. Tabs use this to
   * open a tab from the full source, name, and project id — not just the id.
   */
  selectedDiagram: DiagramFile | null;
  /** The DSL source currently shown in the editor. */
  source: string;
  /** True while the initial load or any action is in flight. */
  isLoading: boolean;
  /** The last error surfaced by the repository, or `null`. */
  error: Error | null;
  /** Load a diagram's source into the editor and select its project. */
  loadDiagram(diagram: DiagramFile): void;
  /** Persist the current source back to the loaded diagram file. */
  saveCurrentDiagram(source: string): Promise<void>;
  /** Create a new empty project and select it. */
  createProject(name: string): Promise<void>;
  /** Delete a project (and its diagrams). Clears the editor. */
  deleteProject(id: string): Promise<void>;
}

/** The mutable pieces of {@link WorkspaceHook}, passed as a single object. */
interface ProjectSetters {
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setDiagrams: Dispatch<SetStateAction<DiagramFile[]>>;
  setSelectedProjectId: (value: string | null) => void;
  setSelectedDiagramId: (value: string | null) => void;
  setSource: (value: string) => void;
  setError: (value: Error | null) => void;
}

/** Load a project's diagrams, auto-selecting the first one. */
async function selectProject(
  repo: WorkspaceRepository,
  projectId: string,
  setters: ProjectSetters,
): Promise<void> {
  setters.setSelectedProjectId(projectId);
  setters.setSelectedDiagramId(null);
  const result: Result<DiagramFile[], Error> =
    await repo.listDiagramFiles(projectId);
  if (isOk(result)) {
    const next = result.value;
    setters.setDiagrams(next);
    if (next.length > 0) {
      setters.setSelectedDiagramId(next[0].id);
      setters.setSource(next[0].source);
    } else {
      setters.setSource("");
    }
  } else {
    setters.setError(result.error);
    setters.setDiagrams([]);
    setters.setSource("");
  }
}

/**
 * Bind the {@link WorkspaceRepository} to React state.
 *
 * The initial load runs once on mount; individual actions each open their own
 * transaction and refresh the affected state. Every repository error is captured
 * in `error` so the UI can surface it without catching exceptions.
 */
export function useWorkspace(repo: WorkspaceRepository): WorkspaceHook {
  const [projects, setProjects] = useState<Project[]>([]);
  const [diagrams, setDiagrams] = useState<DiagramFile[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [selectedDiagramId, setSelectedDiagramId] = useState<string | null>(
    null,
  );
  // Seed the editor with a valid sample so the preview is populated synchronously
  // on first render, before the async load resolves.
  const [source, setSource] = useState<string>(SAMPLE_SOURCE);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const setters: ProjectSetters = {
    setProjects,
    setDiagrams,
    setSelectedProjectId,
    setSelectedDiagramId,
    setSource,
    setError,
  };

  // The loaded diagram file itself (matched by id), so tabs can open from the
  // full source, name, and project id rather than the id alone.
  const selectedDiagram =
    diagrams.find((diagram) => diagram.id === selectedDiagramId) ?? null;

  // Initial load: projects plus the first project's diagrams (if any). The seed
  // above keeps the preview populated until this resolves; on an empty repository
  // the sample is left in place rather than blanked.
  useEffect(() => {
    let active = true;
    (async () => {
      setIsLoading(true);
      setError(null);
      const projectsResult: Result<Project[], Error> =
        await repo.listProjects();
      if (!active) return;
      if (isOk(projectsResult)) {
        setters.setProjects(projectsResult.value);
        if (projectsResult.value.length > 0) {
          await selectProject(repo, projectsResult.value[0].id, setters);
        } else {
          setters.setDiagrams([]);
        }
      } else {
        setError(projectsResult.error);
      }
      setIsLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [repo]);

  const loadDiagram = useCallback((diagram: DiagramFile) => {
    setSelectedProjectId(diagram.projectId);
    setSelectedDiagramId(diagram.id);
    setSource(diagram.source);
    setError(null);
  }, []);

  const saveCurrentDiagram = useCallback(
    async (nextSource: string): Promise<void> => {
      // Update source first so the preview re-renders in lockstep with edits,
      // then persist asynchronously. When no diagram is loaded there is nothing
      // to save, but the editor should still reflect what the user typed.
      setSource(nextSource);
      if (!selectedProjectId || !selectedDiagramId) return;
      const result: Result<DiagramFile, Error> = await repo.saveDiagramFile(
        selectedProjectId,
        {
          id: selectedDiagramId,
          name:
            diagrams.find((diagram) => diagram.id === selectedDiagramId)
              ?.name ?? "Untitled",
          source: nextSource,
          projectId: selectedProjectId,
        },
      );
      if (!isOk(result)) {
        setError(result.error);
      }
    },
    [repo, selectedProjectId, selectedDiagramId, diagrams, setSource],
  );

  const createProject = useCallback(
    async (name: string): Promise<void> => {
      const result: Result<Project, Error> = await repo.createProject(name);
      if (isOk(result)) {
        setters.setProjects((current: Project[]) => [...current, result.value]);
        await selectProject(repo, result.value.id, setters);
      } else {
        setError(result.error);
      }
    },
    [repo],
  );

  const deleteProject = useCallback(
    async (id: string): Promise<void> => {
      const result: Result<void, Error> = await repo.deleteProject(id);
      if (isOk(result)) {
        setters.setProjects((current: Project[]) =>
          current.filter((project) => project.id !== id),
        );
        if (selectedProjectId === id) {
          setSelectedProjectId(null);
          setSelectedDiagramId(null);
          setSource("");
          setDiagrams([]);
        }
      } else {
        setError(result.error);
      }
    },
    [repo, selectedProjectId],
  );

  return {
    projects,
    diagrams,
    selectedProjectId,
    selectedDiagramId,
    selectedDiagram,
    source,
    isLoading,
    error,
    loadDiagram,
    saveCurrentDiagram,
    createProject,
    deleteProject,
  };
}
