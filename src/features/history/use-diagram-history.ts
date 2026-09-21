/**
 * Version-history state hook.
 *
 * `useDiagramHistory` turns a {@link VersionHistoryStore} into the timeline the
 * History panel renders, and owns *when* a version is captured:
 *
 * - One version the first time a diagram is opened (its `Initial version`).
 * - One automatic checkpoint after edits settle, so a normal editing session
 *   produces a readable trajectory without a checkpoint per keystroke. The
 *   debounce is what makes "type a line" one entry instead of forty.
 * - Explicit checkpoints on demand (the panel's "Save version"), and labeled
 *   entries when a version is restored.
 *
 * Capturing is content-aware: a source identical to the newest recorded version
 * is never recorded twice, so opening a diagram, switching tabs, and restoring
 * the newest version do not grow the timeline. The hook never touches the editor
 * source itself — restoring is the caller's job — which keeps it a plain data
 * hook and easy to test.
 */
import { useCallback, useEffect, useState } from "react";
import type { DiagramFile } from "../../domain/workspace/types";
import type { DiagramVersion } from "../../domain/workspace/version";
import {
  AUTO_CHECKPOINT_DEBOUNCE_MS,
  AUTO_VERSION_LABEL,
  INITIAL_VERSION_LABEL,
  MANUAL_VERSION_LABEL,
} from "../../domain/workspace/version";
import { isOk } from "../../shared/result/result";
import type { VersionHistoryStore } from "../../workspace/version-history";

/** The state and actions exposed by {@link useDiagramHistory}. */
export interface DiagramHistoryHook {
  /** The active diagram's timeline, newest first. */
  versions: DiagramVersion[];
  /**
   * Every version in the selected project, across all of its diagrams, newest
   * first. The panel renders this as a tree of branches.
   */
  projectVersions: DiagramVersion[];
  /** True while a timeline load is in flight. */
  isLoading: boolean;
  /**
   * Capture `source` as a labeled checkpoint. A no-op when it matches the newest
   * recorded version.
   */
  saveVersion(source: string, label?: string): Promise<void>;
  /** Forget a single version. */
  removeVersion(versionId: string): Promise<void>;
  /** Forget one diagram's whole timeline (called when its file is deleted). */
  clearDiagram(diagramId: string): Promise<void>;
  /** Forget every timeline in a project (called when the project is deleted). */
  clearProject(projectId: string): Promise<void>;
  /**
   * Move a timeline to a new diagram id, so a rename in a local folder does not
   * detach the history from the file it belongs to.
   */
  renameDiagram(fromDiagramId: string, toDiagramId: string): Promise<void>;
}

/**
 * Bind a version store to a diagram and its current buffer.
 *
 * @param store - Where timelines are persisted.
 * @param diagram - The active diagram, or `null` when none is loaded.
 * @param source - The active buffer for `diagram`, or `null` when no matching
 *   buffer is loaded yet. Passing `null` suppresses automatic checkpoints, which
 *   is what prevents a stale buffer from another tab being recorded against the
 *   newly selected diagram during the render that switches between them.
 * @param projectId - The selected project, whose whole history the panel shows
 *   as a tree. `null` while no project is selected.
 */
export function useDiagramHistory(
  store: VersionHistoryStore,
  diagram: DiagramFile | null,
  source: string | null,
  projectId: string | null = null,
): DiagramHistoryHook {
  const [versions, setVersions] = useState<DiagramVersion[]>([]);
  const [projectVersions, setProjectVersions] = useState<DiagramVersion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const diagramId = diagram?.id ?? null;

  /** Re-read the active diagram's timeline into state. */
  const refresh = useCallback(
    async (id: string): Promise<void> => {
      const result = await store.listVersions(id);
      if (isOk(result)) setVersions(result.value);
    },
    [store],
  );

  /** Re-read the selected project's whole history into state. */
  const refreshProject = useCallback(
    async (id: string): Promise<void> => {
      const result = await store.listProjectVersions(id);
      if (isOk(result)) setProjectVersions(result.value);
    },
    [store],
  );

  // Load the project-wide tree whenever the selected project changes, so the
  // panel shows every diagram's branch even before one of them is opened.
  useEffect(() => {
    if (!projectId) {
      setProjectVersions((current) => (current.length === 0 ? current : []));
      return;
    }
    let active = true;
    void (async () => {
      const result = await store.listProjectVersions(projectId);
      if (active && isOk(result)) setProjectVersions(result.value);
    })();
    return () => {
      active = false;
    };
  }, [store, projectId]);

  // Load the timeline whenever the selected diagram changes, seeding the very
  // first version from the diagram's saved source so the trajectory has a
  // starting point even before the user edits anything.
  useEffect(() => {
    let active = true;
    if (!diagram) {
      // Bail out with the same array when already empty so clearing the editor
      // does not trigger a redundant render.
      setVersions((current) => (current.length === 0 ? current : []));
      return;
    }
    const opened = diagram;
    setIsLoading(true);
    (async () => {
      const loaded = await store.listVersions(opened.id);
      if (!active) return;
      if (isOk(loaded)) {
        setVersions(loaded.value);
        if (loaded.value.length === 0) {
          await store.recordVersion({
            diagramId: opened.id,
            projectId: opened.projectId,
            name: opened.name,
            source: opened.source,
            label: INITIAL_VERSION_LABEL,
          });
          if (active) {
            await refresh(opened.id);
            await refreshProject(opened.projectId);
          }
        }
      }
      if (active) setIsLoading(false);
    })();
    return () => {
      active = false;
    };
    // The diagram's own fields are read from the captured `opened` value; only
    // its identity should reload the timeline.
  }, [store, diagramId, refresh, refreshProject]);

  // Automatic checkpoint: after the buffer has been quiet for the debounce
  // window, record it. The cleanup clears the pending timer on every keystroke,
  // so only the final resting state is captured.
  useEffect(() => {
    if (!diagram || source === null) return;
    const target = diagram;
    const pending = source;
    const timer = setTimeout(() => {
      void (async () => {
        const result = await store.recordVersion({
          diagramId: target.id,
          projectId: target.projectId,
          name: target.name,
          source: pending,
          label: AUTO_VERSION_LABEL,
        });
        // Only refresh when the timeline actually grew; an unchanged source
        // returns the existing newest version and needs no re-render.
        if (isOk(result) && result.value.source === pending) {
          await refresh(target.id);
          await refreshProject(target.projectId);
        }
      })();
    }, AUTO_CHECKPOINT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [store, diagram, source, refresh, refreshProject]);

  const saveVersion = useCallback(
    async (
      nextSource: string,
      label: string = MANUAL_VERSION_LABEL,
    ): Promise<void> => {
      if (!diagram) return;
      const result = await store.recordVersion({
        diagramId: diagram.id,
        projectId: diagram.projectId,
        name: diagram.name,
        source: nextSource,
        label,
      });
      if (isOk(result)) {
        await refresh(diagram.id);
        await refreshProject(diagram.projectId);
      }
    },
    [store, diagram, refresh, refreshProject],
  );

  const removeVersion = useCallback(
    async (versionId: string): Promise<void> => {
      await store.deleteVersion(versionId);
      if (diagramId) await refresh(diagramId);
      if (projectId) await refreshProject(projectId);
    },
    [store, diagramId, projectId, refresh, refreshProject],
  );

  const clearDiagram = useCallback(
    async (targetId: string): Promise<void> => {
      await store.clearDiagram(targetId);
      if (diagramId === targetId) setVersions([]);
      if (projectId) await refreshProject(projectId);
    },
    [store, diagramId, projectId, refreshProject],
  );

  const clearProject = useCallback(
    async (targetProjectId: string): Promise<void> => {
      await store.clearProject(targetProjectId);
      if (diagram && diagram.projectId === targetProjectId) setVersions([]);
      if (projectId === targetProjectId) setProjectVersions([]);
    },
    [store, diagram, projectId],
  );

  const renameDiagram = useCallback(
    async (fromDiagramId: string, toDiagramId: string): Promise<void> => {
      await store.renameDiagram(fromDiagramId, toDiagramId);
      if (projectId) await refreshProject(projectId);
    },
    [store, projectId, refreshProject],
  );

  return {
    versions,
    projectVersions,
    isLoading,
    saveVersion,
    removeVersion,
    clearDiagram,
    clearProject,
    renameDiagram,
  };
}
