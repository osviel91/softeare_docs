/**
 * Repository construction for the Explorer feature (Phase 4).
 *
 * `useWorkspaceRepository` builds the production repository over IndexedDB, but
 * falls back to an in-memory repository when IndexedDB is unavailable (for example
 * in jsdom). This keeps the app renderable everywhere while remaining persistent
 * in real browsers. Tests bypass this layer by injecting their own {@link IdbFactory}
 * directly into {@link createIndexedDbRepository}.
 */
import { useMemo } from "react";
import { createInMemoryWorkspaceRepository } from "../../workspace/in-memory";
import { createIndexedDbRepository } from "../../workspace/indexed-db";
import type { WorkspaceRepository } from "../../workspace/WorkspaceRepository";

/** Memoize the default repository across renders. */
export function useWorkspaceRepository(): WorkspaceRepository {
  return useMemo<WorkspaceRepository>(() => createDefaultRepository(), []);
}

/**
 * Build the default workspace repository.
 *
 * Attempts IndexedDB first; if the global is unavailable, falls back to an
 * in-memory repository so the app still works (non-persistently).
 */
export function createDefaultRepository(): WorkspaceRepository {
  try {
    return createIndexedDbRepository();
  } catch (error) {
    if (typeof indexedDB === "undefined") {
      return createInMemoryWorkspaceRepository();
    }
    throw error;
  }
}
