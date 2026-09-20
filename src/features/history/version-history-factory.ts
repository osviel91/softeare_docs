/**
 * Version-history store construction.
 *
 * Mirrors the workspace repository factory: IndexedDB when the browser provides
 * it, and an in-memory fallback so the app (and jsdom tests) still render with a
 * working timeline everywhere. The fallback is non-persistent and per-session,
 * which is acceptable for a feature that only needs to offer undo within a run
 * when no durable store exists.
 */
import { useMemo } from "react";
import type { VersionHistoryStore } from "../../workspace/version-history";
import { createInMemoryVersionHistory } from "../../workspace/version-history";
import { createIndexedDbVersionHistory } from "../../workspace/version-history-idb";

/**
 * Build the default version-history store, preferring IndexedDB.
 *
 * The availability check comes first because constructing the IndexedDB store
 * never throws — only opening the database does — so a `try`/`catch` around
 * construction alone would pick a store that fails on every read and leave the
 * timeline permanently empty in environments without IndexedDB.
 */
export function createDefaultVersionHistory(): VersionHistoryStore {
  if (typeof indexedDB === "undefined") {
    return createInMemoryVersionHistory();
  }
  try {
    return createIndexedDbVersionHistory();
  } catch {
    return createInMemoryVersionHistory();
  }
}

/** Memoize the default version-history store across renders. */
export function useVersionHistory(): VersionHistoryStore {
  return useMemo<VersionHistoryStore>(() => createDefaultVersionHistory(), []);
}
