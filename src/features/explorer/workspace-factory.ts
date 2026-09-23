/**
 * Repository construction for the Explorer feature.
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
 * Uses IndexedDB when the global exists, and falls back to an in-memory
 * repository otherwise (jsdom, or a browser with storage disabled) so the app
 * still renders. The availability check comes first because constructing the
 * IndexedDB repository never throws — only opening the database does — so a
 * `try`/`catch` around construction alone would silently pick a repository that
 * fails on every operation.
 */
export function createDefaultRepository(): WorkspaceRepository {
  if (typeof indexedDB === "undefined") {
    return createInMemoryWorkspaceRepository();
  }
  try {
    return createIndexedDbRepository();
  } catch {
    return createInMemoryWorkspaceRepository();
  }
}
