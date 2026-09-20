/**
 * The project index as React state.
 *
 * The hook owns an {@link ProjectIndexer} for the lifetime of the shell, so its
 * per-resource analyses survive re-renders: editing one diagram re-parses one
 * diagram, and the project view is reassembled from the cache. The indexer is
 * cleared when a different project is opened, because analyses describe a
 * project's files and mean nothing outside it.
 *
 * Nothing else in the UI computes project facts. Panels read this index, so the
 * problems list, the outline, find-references and the dashboard cannot disagree
 * about what the project contains.
 */
import { useMemo, useRef } from "react";
import type { DiagramFile, NoteFile } from "../../domain/workspace/types";
import type { ProjectMetadata } from "../../domain/workspace/metadata";
import { createProjectIndexer } from "../../domain/project/indexer";
import type { ProjectIndex } from "../../domain/project/project-index";
import { toSourceFiles } from "../../services/project-service";

/**
 * Build the active project's index, re-analysing only what changed.
 *
 * Returns `null` until a project and its identity record are loaded, so callers
 * can distinguish "no project" from "an empty project".
 */
export function useProjectIndex(
  projectId: string | null,
  diagrams: DiagramFile[],
  notes: NoteFile[],
  metadata: ProjectMetadata | null,
): ProjectIndex | null {
  const indexerRef = useRef(createProjectIndexer());
  const loadedProject = useRef<string | null>(null);

  // Analyses describe one project's files, so they are dropped when the user
  // moves to another project rather than being matched against unrelated paths.
  if (loadedProject.current !== projectId) {
    loadedProject.current = projectId;
    indexerRef.current.clear();
  }

  return useMemo(() => {
    if (!projectId || !metadata) return null;
    return indexerRef.current.update(
      projectId,
      toSourceFiles(projectId, diagrams, notes, metadata),
      metadata,
    );
  }, [projectId, diagrams, notes, metadata]);
}
