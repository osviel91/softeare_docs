/**
 * Tab-set model (Phase 6).
 *
 * A {@link Tab} is an open diagram shown in the editor. Every tab is backed by a
 * saved {@link DiagramFile} from the workspace (there are no "scratch" tabs):
 * `diagramId` is the stable id of that file, and `source` is the buffer currently
 * shown in the editor for it. Because the editor auto-saves on every edit (see
 * `useTabs`), a tab never loses work — the buffer is just what the user last
 * typed, kept in memory so switching tabs preserves each diagram's in-progress
 * edits.
 *
 * A {@link TabSet} is an immutable value: a list of tabs plus the id of the active
 * one. All mutations here are pure functions that return a new {@link TabSet}, so
 * the UI can treat tab state as plain data and diff it cheaply. This module is
 * framework-free — no React, no repository — which keeps the tab logic unit
 * testable in isolation.
 */
import type { DiagramFile } from "../../domain/workspace/types";

/** A single open diagram. */
export interface Tab {
  /**
   * The id of the backed {@link DiagramFile}. Used as the tab's stable key and
   * as the id by which tabs are looked up, activated, and closed.
   */
  id: DiagramFile["id"];
  /** The diagram file this tab shows. */
  diagramId: DiagramFile["id"];
  /** The id of the project this diagram belongs to; needed to persist edits. */
  projectId: DiagramFile["projectId"];
  /** The display label in the tab bar (the diagram's name). */
  title: string;
  /** The DSL source buffer currently shown for this tab. */
  source: string;
}

/** An ordered set of open tabs plus the active one. */
export interface TabSet {
  /** Every open tab, in the order they were opened. */
  tabs: Tab[];
  /** The id of the active tab, or `null` when none is open. */
  activeTabId: string | null;
}

/** An empty tab set with no open tabs. */
export function createEmptyTabSet(): TabSet {
  return { tabs: [], activeTabId: null };
}

/** Whether a tab for the given diagram id is already open. */
export function hasTab(set: TabSet, diagramId: DiagramFile["id"]): boolean {
  return set.tabs.some((tab) => tab.id === diagramId);
}

/** The active tab, or `null` when none is open. */
export function getActiveTab(set: TabSet): Tab | null {
  return set.tabs.find((tab) => tab.id === set.activeTabId) ?? null;
}

/**
 * Open a diagram in a tab and make it active.
 *
 * If a tab for this diagram is already open, it is activated as-is (its buffer is
 * preserved). Otherwise a new tab is appended from the diagram's current source and
 * activated.
 */
export function openDiagram(set: TabSet, diagram: DiagramFile): TabSet {
  const existing = set.tabs.find((tab) => tab.id === diagram.id);
  if (existing) {
    return { ...set, activeTabId: existing.id };
  }
  const tab: Tab = {
    id: diagram.id,
    diagramId: diagram.id,
    projectId: diagram.projectId,
    title: diagram.name,
    source: diagram.source,
  };
  return { tabs: [...set.tabs, tab], activeTabId: tab.id };
}

/** Activate an open tab. No-op (returns the same state) when it is not open. */
export function activateDiagram(
  set: TabSet,
  diagramId: DiagramFile["id"],
): TabSet {
  if (!hasTab(set, diagramId)) return set;
  return { ...set, activeTabId: diagramId };
}

/**
 * Close a tab. When the closed tab was active, the nearest remaining tab becomes
 * active (the previous one if it exists, else the first remaining); with no tabs
 * left the active id clears to `null`. No-op when the tab is not open.
 */
export function closeDiagram(
  set: TabSet,
  diagramId: DiagramFile["id"],
): TabSet {
  const index = set.tabs.findIndex((tab) => tab.id === diagramId);
  if (index === -1) return set;

  const tabs = set.tabs.filter((tab) => tab.id !== diagramId);
  if (tabs.length === 0) {
    return { tabs: [], activeTabId: null };
  }

  if (set.activeTabId !== diagramId) {
    // Only the active tab was closed; leave the active selection untouched.
    return { tabs, activeTabId: set.activeTabId };
  }

  // The closed tab was active. Prefer the tab that was just before it so the
  // user's place feels natural; fall back to the first remaining tab.
  const nextIndex = Math.max(0, index - 1);
  return { tabs, activeTabId: tabs[nextIndex].id };
}

/** Replace the source buffer of a tab. No-op when the tab is not open. */
export function updateTabSource(
  set: TabSet,
  diagramId: DiagramFile["id"],
  source: string,
): TabSet {
  if (!set.tabs.some((tab) => tab.id === diagramId)) return set;
  return {
    ...set,
    tabs: set.tabs.map((tab) =>
      tab.id === diagramId ? { ...tab, source } : tab,
    ),
  };
}
