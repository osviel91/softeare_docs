/**
 * Version history store: the persistence contract behind the Trajectory panel.
 *
 * The workspace repository owns projects and diagrams; the version store owns
 * their change timelines. They are separate because a timeline outlives a delete
 * choice ("remove from app" keeps history, a disk delete clears it) and because
 * history is app-local metadata even when the diagram itself lives in a folder.
 *
 * Two implementations share the same pure rules ({@link shouldRecordVersion},
 * {@link prependAndPrune}): an in-memory store for tests and for environments
 * without IndexedDB, and an IndexedDB store (see `version-history-idb.ts`). Every
 * read returns `Result` so the UI can report a failure instead of throwing.
 */
import type { DiagramVersion } from "../domain/workspace/version";
import {
  MAX_VERSIONS_PER_DIAGRAM,
  sameVersionContent,
} from "../domain/workspace/version";
import { newVersionId } from "../domain/workspace/workspace-ids";
import { err, ok, type Result } from "../shared/result/result";

/** What a caller supplies to record a version; the store fills in id and time. */
export interface RecordVersionInput {
  /** The diagram the version belongs to. */
  diagramId: string;
  /** The project the diagram belongs to. */
  projectId: string;
  /** The diagram's file name. */
  name: string;
  /** The complete DSL source to capture. */
  source: string;
  /** A short reason shown in the timeline. */
  label: string;
}

/** The persistence contract for per-diagram version timelines. */
export interface VersionHistoryStore {
  /** Every version of a diagram, newest first. */
  listVersions(diagramId: string): Promise<Result<DiagramVersion[], Error>>;
  /**
   * Every version belonging to a project, across all of its diagrams, newest
   * first. This is what lets the panel show the project's history as a tree
   * rather than one branch at a time.
   */
  listProjectVersions(
    projectId: string,
  ): Promise<Result<DiagramVersion[], Error>>;
  /**
   * Capture a version. A source identical to the newest recorded one is not
   * re-recorded; the existing newest version is returned instead.
   */
  recordVersion(
    input: RecordVersionInput,
  ): Promise<Result<DiagramVersion, Error>>;
  /** Forget one version. */
  deleteVersion(versionId: string): Promise<Result<void, Error>>;
  /** Forget a diagram's entire timeline (used when its file is deleted). */
  clearDiagram(diagramId: string): Promise<Result<void, Error>>;
  /** Forget every timeline in a project (used when the project is deleted). */
  clearProject(projectId: string): Promise<Result<void, Error>>;
  /**
   * Move a timeline to a new diagram id.
   *
   * A local-folder rename changes the file's path and therefore its id, so the
   * recorded versions must follow it or the history would silently detach.
   */
  renameDiagram(
    fromDiagramId: string,
    toDiagramId: string,
  ): Promise<Result<void, Error>>;
}

/** The newest version in a newest-first list, or `null` when empty. */
export function latestVersion(
  versions: DiagramVersion[],
): DiagramVersion | null {
  return versions.length > 0 ? versions[0] : null;
}

/**
 * Order versions newest first by the time they were recorded.
 *
 * A store's own return order is a storage detail — the in-memory fake returns
 * insertion order, IndexedDB returns key order — so recency has to come from
 * `createdAt`. The sort is stable, which keeps versions recorded in the same
 * millisecond in the per-diagram order the timeline already established.
 */
export function newestVersionsFirst(
  versions: DiagramVersion[],
): DiagramVersion[] {
  return [...versions].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Whether a new version should be recorded for `source`.
 *
 * Nothing is recorded when the source matches the newest version's content, so
 * navigating between diagrams or retyping the same text does not grow the
 * timeline. The first version is always recorded, even for empty source.
 */
export function shouldRecordVersion(
  versions: DiagramVersion[],
  source: string,
): boolean {
  const latest = latestVersion(versions);
  if (!latest) return true;
  return !sameVersionContent(latest.source, source);
}

/**
 * Add a version to the front of a newest-first list and cap the list length.
 *
 * The oldest entries beyond {@link MAX_VERSIONS_PER_DIAGRAM} are dropped, so a
 * long editing session cannot grow the store without bound.
 */
export function prependAndPrune(
  versions: DiagramVersion[],
  version: DiagramVersion,
): DiagramVersion[] {
  const next = [version, ...versions];
  return next.length > MAX_VERSIONS_PER_DIAGRAM
    ? next.slice(0, MAX_VERSIONS_PER_DIAGRAM)
    : next;
}

/** Build a complete version from caller input, stamping id and time. */
export function makeVersion(
  input: RecordVersionInput,
  now: number = Date.now(),
  id: string = newVersionId(),
): DiagramVersion {
  return {
    id,
    diagramId: input.diagramId,
    projectId: input.projectId,
    name: input.name,
    source: input.source,
    createdAt: now,
    label: input.label,
  };
}

/**
 * An in-memory {@link VersionHistoryStore}. Used as the fallback when IndexedDB
 * is unavailable and as the deterministic double in tests.
 */
export function createInMemoryVersionHistory(): VersionHistoryStore {
  const byDiagram = new Map<string, DiagramVersion[]>();

  return {
    async listVersions(
      diagramId: string,
    ): Promise<Result<DiagramVersion[], Error>> {
      try {
        // Copy so callers cannot mutate the stored timeline in place.
        return ok([...(byDiagram.get(diagramId) ?? [])]);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async listProjectVersions(
      projectId: string,
    ): Promise<Result<DiagramVersion[], Error>> {
      try {
        const all: DiagramVersion[] = [];
        for (const versions of byDiagram.values()) {
          for (const version of versions) {
            if (version.projectId === projectId) all.push(version);
          }
        }
        return ok(newestVersionsFirst(all));
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async recordVersion(
      input: RecordVersionInput,
    ): Promise<Result<DiagramVersion, Error>> {
      try {
        const current = byDiagram.get(input.diagramId) ?? [];
        if (!shouldRecordVersion(current, input.source)) {
          return ok(current[0]);
        }
        const version = makeVersion(input);
        byDiagram.set(input.diagramId, prependAndPrune(current, version));
        return ok(version);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async deleteVersion(versionId: string): Promise<Result<void, Error>> {
      try {
        for (const [diagramId, versions] of byDiagram) {
          const next = versions.filter((version) => version.id !== versionId);
          if (next.length !== versions.length) byDiagram.set(diagramId, next);
        }
        return ok(undefined);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async clearDiagram(diagramId: string): Promise<Result<void, Error>> {
      try {
        byDiagram.delete(diagramId);
        return ok(undefined);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async clearProject(projectId: string): Promise<Result<void, Error>> {
      try {
        for (const [diagramId, versions] of byDiagram) {
          if (versions.some((version) => version.projectId === projectId)) {
            byDiagram.delete(diagramId);
          }
        }
        return ok(undefined);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async renameDiagram(
      fromDiagramId: string,
      toDiagramId: string,
    ): Promise<Result<void, Error>> {
      try {
        if (fromDiagramId === toDiagramId) return ok(undefined);
        const versions = byDiagram.get(fromDiagramId);
        if (!versions) return ok(undefined);
        byDiagram.delete(fromDiagramId);
        byDiagram.set(
          toDiagramId,
          versions.map((version) => ({ ...version, diagramId: toDiagramId })),
        );
        return ok(undefined);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
