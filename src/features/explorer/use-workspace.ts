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
  /**
   * Every diagram file in the workspace, across all projects. Loaded once at
   * startup (and kept current as files are created or opened) so the explorer
   * search box can filter by name across projects, not just the selected one.
   */
  allDiagrams: DiagramFile[];
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
  /**
   * Create an empty diagram in a project, add it to the explorer's list, select
   * it, and return it (or `null` on failure). The "New diagram" command drives
   * this, then opens the returned file into a tab.
   */
  createEmptyDiagram(projectId: string): Promise<DiagramFile | null>;
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
  /** Merge the listed files into the workspace-wide list used for search. */
  mergeDiagrams: (diagrams: DiagramFile[]) => void,
): Promise<void> {
  setters.setSelectedProjectId(projectId);
  setters.setSelectedDiagramId(null);
  const result: Result<DiagramFile[], Error> =
    await repo.listDiagramFiles(projectId);
  if (isOk(result)) {
    const next = result.value;
    setters.setDiagrams(next);
    // Keep the workspace-wide list (used by the search box) current as the user
    // navigates between projects.
    mergeDiagrams(next);
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
  // Every diagram file in the workspace, keyed by id. Loaded once at startup and
  // kept current as files are created or opened; the explorer search filters by
  // name across this list (see Explorer), so it spans projects, not just the
  // selected one.
  const [allDiagrams, setAllDiagrams] = useState<DiagramFile[]>([]);
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

  // Merge a batch of diagram files into the workspace-wide list by id, updating
  // in place (so a re-listed file carries its latest name/source) and appending
  // any new ones. Stable across renders since it only wraps a state setter.
  const mergeDiagrams = useCallback((next: DiagramFile[]) => {
    if (next.length === 0) return;
    setAllDiagrams((current) => {
      const byId = new Map(current.map((diagram) => [diagram.id, diagram]));
      for (const diagram of next) byId.set(diagram.id, diagram);
      return [...byId.values()];
    });
  }, []);

  const setters: ProjectSetters = {
    setProjects,
    setDiagrams,
    setSelectedProjectId,
    setSelectedDiagramId,
    setSource,
    setError,
  };

  // The loaded diagram file itself (matched by id), so tabs can open from the
  // full source, name, and project id rather than the id alone. It is resolved
  // against {@link allDiagrams} — every project's loaded files, populated on the
  // initial load and kept current by {@link loadDiagram} — so a diagram selected
  // from another project (e.g. via the search box) still resolves even though
  // {@link diagrams} only lists the currently selected project's files.
  const selectedDiagram =
    allDiagrams.find((diagram) => diagram.id === selectedDiagramId) ?? null;

  // Initial load: projects plus every project's diagrams. Loading all diagrams
  // up front (rather than just the first project's) is what lets the explorer
  // search box filter by name across projects. The seed above keeps the preview
  // populated until this resolves; on an empty repository the sample is left in
  // place rather than blanked.
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
        const all: DiagramFile[] = [];
        for (const project of projectsResult.value) {
          const files: Result<DiagramFile[], Error> =
            await repo.listDiagramFiles(project.id);
          if (isOk(files)) all.push(...files.value);
        }
        mergeDiagrams(all);
        if (projectsResult.value.length > 0) {
          await selectProject(
            repo,
            projectsResult.value[0].id,
            setters,
            mergeDiagrams,
          );
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
  }, [repo, mergeDiagrams]);

  const loadDiagram = useCallback(
    (diagram: DiagramFile) => {
      // Ensure the clicked diagram is part of the workspace-wide list so it
      // remains findable after navigating into a project.
      mergeDiagrams([diagram]);
      setSelectedProjectId(diagram.projectId);
      setSelectedDiagramId(diagram.id);
      setSource(diagram.source);
      setError(null);
    },
    [mergeDiagrams],
  );

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
        await selectProject(repo, result.value.id, setters, mergeDiagrams);
      } else {
        setError(result.error);
      }
    },
    [repo, mergeDiagrams],
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

  const createEmptyDiagram = useCallback(
    async (projectId: string): Promise<DiagramFile | null> => {
      const result: Result<DiagramFile, Error> =
        await repo.createEmptyDiagram(projectId);
      if (!isOk(result)) {
        setError(result.error);
        return null;
      }
      const diagram = result.value;
      // Add it to the explorer's list for this project (when it is the selected
      // one) and select it, so the new file appears and is ready to edit. The
      // caller then opens its tab.
      setDiagrams((current: DiagramFile[]) =>
        current.some((item) => item.id === diagram.id)
          ? current
          : [...current, diagram],
      );
      // Keep the workspace-wide list current so the new file is searchable.
      mergeDiagrams([diagram]);
      setters.setSelectedProjectId(projectId);
      setters.setSelectedDiagramId(diagram.id);
      setters.setSource(diagram.source);
      return diagram;
    },
    [repo, setters, mergeDiagrams],
  );

  return {
    projects,
    diagrams,
    allDiagrams,
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
    createEmptyDiagram,
  };
}
