/**
 * Document tab-set model.
 *
 * A {@link Tab} is an open project document shown in the editor. Every tab is
 * backed by a saved resource — a {@link DiagramFile} or a {@link NoteFile} (see
 * {@link TabDocument}) — there are no "scratch" tabs. Because the editor
 * auto-saves on every edit (see `useTabs`), a tab never loses work: `source` is
 * what the user last typed and `savedSource` is what was last persisted, so
 * {@link isDirty} is simply the two disagreeing.
 *
 * A {@link TabSet} is an immutable value: a list of tabs plus the id of the
 * active one. All mutations here are pure functions that return a new
 * {@link TabSet}, so the UI can treat tab state as plain data and diff it
 * cheaply. This module is framework-free — no React, no repository — which
 * keeps the tab logic unit-testable in isolation.
 */
import type { ResourceKind } from "../../domain/workspace/resource";
import type { DiagramFile, NoteFile } from "../../domain/workspace/types";
import { diagramDisplayName } from "../../language/diagram-title";
import { noteDisplayName } from "../../language/markdown/note-title";

/** A tab's resource kind — the same kinds a project can store. */
export type TabKind = ResourceKind;

/**
 * What is needed to open a document in a tab: its identity plus its current
 * content. {@link tabDocumentOfDiagram} and {@link tabDocumentOfNote} build one
 * from a stored file, so callers never hand-assemble the shape.
 */
export interface TabDocument {
  /** Which kind of resource this document is. */
  kind: TabKind;
  /** Stable id of the backing file. */
  id: string;
  /** The project the file belongs to; needed to persist edits. */
  projectId: string;
  /**
   * The backing file's name. Kept so edits persist to the same file even after
   * its title changes (a title lives in the content, not the file name).
   */
  name: string;
  /** DSL source for a diagram, markdown for a note. */
  source: string;
  /** Optional semantic context stored beside the source. */
  metadata?: DiagramFile["metadata"];
}

/** A single open document. */
export interface Tab {
  /**
   * The id of the backing resource. Used as the tab's stable key and as the id
   * by which tabs are looked up, activated, and closed.
   */
  id: string;
  /** Which kind of resource this tab shows. */
  kind: TabKind;
  /** The document this tab shows (same value as {@link id}). */
  documentId: string;
  /** The id of the project this document belongs to. */
  projectId: string;
  /** The backing file's name, for persistence. */
  name: string;
  /**
   * The display label in the tab bar: the title declared in the content (a
   * diagram `title`, a note's first heading), falling back to {@link name}.
   * Recomputed from the buffer as the user edits.
   */
  title: string;
  /** The buffer currently shown for this tab. */
  source: string;
  /** The buffer last persisted for this tab; differs from {@link source} when dirty. */
  savedSource: string;
  metadata?: TabDocument["metadata"];
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

/** The display title for a document: its declared title, else its file name. */
export function documentTitle(
  kind: TabKind,
  name: string,
  source: string,
): string {
  return kind === "note"
    ? noteDisplayName(name, source)
    : diagramDisplayName(name, source);
}

/** Whether a tab holds edits that have not been persisted yet. */
export function isDirty(tab: Tab): boolean {
  return tab.source !== tab.savedSource;
}

/** The tab document for an open diagram file. */
export function tabDocumentOfDiagram(diagram: DiagramFile): TabDocument {
  return {
    kind: "diagram",
    id: diagram.id,
    projectId: diagram.projectId,
    name: diagram.name,
    source: diagram.source,
    metadata: diagram.metadata,
  };
}

/** The tab document for an open markdown note. */
export function tabDocumentOfNote(note: NoteFile): TabDocument {
  return {
    kind: "note",
    id: note.id,
    projectId: note.projectId,
    name: note.name,
    source: note.markdown,
    metadata: note.metadata,
  };
}

/** Whether a tab for the given document id is already open. */
export function hasTab(set: TabSet, documentId: string): boolean {
  return set.tabs.some((tab) => tab.id === documentId);
}

/** The active tab, or `null` when none is open. */
export function getActiveTab(set: TabSet): Tab | null {
  return set.tabs.find((tab) => tab.id === set.activeTabId) ?? null;
}

/**
 * Open a document in a tab and make it active.
 *
 * If a tab for this document is already open it is activated as-is (its buffer,
 * including unsaved edits, is preserved). Otherwise a new tab is appended from
 * the document's current content and activated. A freshly opened buffer counts
 * as saved, so the auto-save effect does not immediately rewrite it.
 */
export function openDocument(set: TabSet, document: TabDocument): TabSet {
  const existing = set.tabs.find((tab) => tab.id === document.id);
  if (existing) {
    return { ...set, activeTabId: existing.id };
  }
  const tab: Tab = {
    id: document.id,
    kind: document.kind,
    documentId: document.id,
    projectId: document.projectId,
    name: document.name,
    title: documentTitle(document.kind, document.name, document.source),
    source: document.source,
    savedSource: document.source,
    metadata: document.metadata,
  };
  return { tabs: [...set.tabs, tab], activeTabId: tab.id };
}

/** Open (or activate) a diagram file. */
export function openDiagram(set: TabSet, diagram: DiagramFile): TabSet {
  return openDocument(set, tabDocumentOfDiagram(diagram));
}

/** Open (or activate) a markdown note. */
export function openNote(set: TabSet, note: NoteFile): TabSet {
  return openDocument(set, tabDocumentOfNote(note));
}

/** Activate an open tab. No-op (returns the same state) when it is not open. */
export function activateTab(set: TabSet, documentId: string): TabSet {
  if (!hasTab(set, documentId)) return set;
  return { ...set, activeTabId: documentId };
}

/**
 * Close a tab. When the closed tab was active, the nearest remaining tab becomes
 * active (the previous one if it exists, else the first remaining); with no tabs
 * left the active id clears to `null`. No-op when the tab is not open.
 */
export function closeTab(set: TabSet, documentId: string): TabSet {
  const index = set.tabs.findIndex((tab) => tab.id === documentId);
  if (index === -1) return set;

  const tabs = set.tabs.filter((tab) => tab.id !== documentId);
  if (tabs.length === 0) {
    return { tabs: [], activeTabId: null };
  }

  if (set.activeTabId !== documentId) {
    // Only an inactive tab was closed; leave the active selection untouched.
    return { tabs, activeTabId: set.activeTabId };
  }

  // The closed tab was active. Prefer the tab that was just before it so the
  // user's place feels natural; fall back to the first remaining tab.
  const nextIndex = Math.max(0, index - 1);
  return { tabs, activeTabId: tabs[nextIndex].id };
}

/**
 * Replace the buffer of a tab. No-op when the tab is not open. The display label
 * is re-derived from the new buffer, so editing a diagram's `title` line (or a
 * note's first heading) relabels the tab as the user types.
 */
export function updateTabSource(
  set: TabSet,
  documentId: string,
  source: string,
): TabSet {
  if (!set.tabs.some((tab) => tab.id === documentId)) return set;
  return {
    ...set,
    tabs: set.tabs.map((tab) =>
      tab.id === documentId
        ? {
            ...tab,
            source,
            title: documentTitle(tab.kind, tab.name, source),
          }
        : tab,
    ),
  };
}

/**
 * Record that a buffer was persisted.
 *
 * `savedSource` is set to the source that was actually written, not to the tab's
 * current buffer: an edit that arrived while the write was in flight keeps the
 * tab dirty, so the next auto-save pass writes it too.
 */
export function markTabSaved(
  set: TabSet,
  documentId: string,
  savedSource: string,
): TabSet {
  if (!set.tabs.some((tab) => tab.id === documentId)) return set;
  return {
    ...set,
    tabs: set.tabs.map((tab) =>
      tab.id === documentId ? { ...tab, savedSource } : tab,
    ),
  };
}

/**
 * Replace an open tab's backing file, name, and buffer from outside the editor.
 *
 * The explorer can change a document's title or rename its file while it is open
 * in a tab; this folds that external change into the tab so the editor and the
 * tab label follow. The incoming content came from storage, so it counts as
 * saved. No-op when the document is not open.
 */
export function replaceDocument(set: TabSet, document: TabDocument): TabSet {
  if (!set.tabs.some((tab) => tab.id === document.id)) return set;
  return {
    ...set,
    tabs: set.tabs.map((tab) =>
      tab.id === document.id
        ? {
            ...tab,
            kind: document.kind,
            projectId: document.projectId,
            name: document.name,
            source: document.source,
            savedSource: document.source,
            title: documentTitle(document.kind, document.name, document.source),
          }
        : tab,
    ),
  };
}
