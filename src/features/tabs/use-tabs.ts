/**
 * Document tab state hook.
 *
 * `useTabs` owns the open-tab set and the buffer shown in the editor/preview. It
 * is fed by {@link useWorkspace}: selecting a diagram or a markdown note in the
 * explorer opens (or activates) that document's tab, and editing the buffer
 * auto-saves back through the active tab's own project and id — diagrams through
 * `saveDiagramFile`, notes through `saveNoteFile`. The preview derives from the
 * same `source`, so the editor and preview stay in lockstep.
 *
 * A tab is always backed by a saved resource — there are no scratch tabs. Because
 * the editor auto-saves on every edit, a tab's buffer is simply what the user last
 * typed; switching tabs preserves each document's in-progress edits without extra
 * bookkeeping. Each tab also remembers the buffer it last persisted, which is
 * what {@link isDirty} reports to the tab strip.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { DiagramFile, NoteFile } from "../../domain/workspace/types";
import { isOk, ok, type Result } from "../../shared/result/result";
import { SAMPLE_SOURCE } from "../../sample-source";
import type { WorkspaceRepository } from "../../workspace/WorkspaceRepository";
import {
  activateTab as activateTabInSet,
  closeTab as closeTabInSet,
  createEmptyTabSet,
  getActiveTab,
  markTabSaved,
  openDocument as openDocumentInSet,
  replaceDocument,
  tabDocumentOfDiagram,
  tabDocumentOfNote,
  updateTabSource,
  type Tab,
  type TabDocument,
  type TabSet,
} from "./tabs";

/** The state and actions exposed by {@link useTabs}. */
export interface TabsHook {
  /** Every open tab, in the order they were opened. */
  tabs: Tab[];
  /** The id of the active tab, or `null` when none is open. */
  activeTabId: string | null;
  /** The active tab itself, or `null` when none is open. */
  activeTab: Tab | null;
  /**
   * The editor/preview buffer. First-class so editing works before any tab is
   * open (the seeded sample); each open tab's buffer mirrors it so switching
   * preserves edits.
   */
  source: string;
  /** Open (or activate) a document and show its content. */
  openDocument(document: TabDocument): void;
  /** Open (or activate) a diagram file. */
  openDiagram(diagram: DiagramFile): void;
  /** Open (or activate) a markdown note. */
  openNote(note: NoteFile): void;
  /** Activate an open tab and show its buffer. */
  activateTab(documentId: string): void;
  /** Close a tab; the strip picks a neighbour when the active tab closes. */
  closeTab(documentId: string): void;
  /** Close the active tab (no-op when none is open). */
  closeActiveTab(): void;
  /** Called by the editor with a new buffer for the active tab (auto-saves). */
  updateActiveSource(source: string): void;
  /**
   * Fold a file changed outside the editor (a title edit or rename from the
   * explorer) into its open tab, so the buffer and label follow. No-op when the
   * document is not open.
   */
  applyExternalDiagram(diagram: DiagramFile): void;
  /** Fold an externally changed note into its open tab, if any. */
  applyExternalNote(note: NoteFile): void;
}

/** The persistence key that identifies one in-flight write. */
function writeKey(tab: Tab): string {
  return `${tab.documentId}\u0000${tab.source}`;
}

/**
 * Persist one document through the repository, dispatching on its kind.
 *
 * The concrete save methods differ only in the field the buffer travels in
 * (`source` for a diagram, `markdown` for a note); the tab strip should not have
 * to care, so that detail is confined here.
 */
async function persistDocument(
  repo: WorkspaceRepository,
  document: TabDocument,
): Promise<Result<void, Error>> {
  if (document.kind === "note") {
    const result = await repo.saveNoteFile(document.projectId, {
      id: document.id,
      name: document.name,
      markdown: document.source,
      projectId: document.projectId,
    });
    return result.ok ? ok(undefined) : result;
  }
  const result = await repo.saveDiagramFile(document.projectId, {
    id: document.id,
    name: document.name,
    source: document.source,
    projectId: document.projectId,
  });
  return result.ok ? ok(undefined) : result;
}

/**
 * Bind the open-tab set to the workspace repository.
 *
 * @param repo - The active workspace repository, used to persist edits.
 * @param selectedDocument - The document the explorer loaded. Opening it creates
 *   or activates its tab. `null` while the async load is in flight, so the editor
 *   falls back to the seeded sample until a real document loads.
 * @param onDocumentEdit - Called with the edited document after each successful
 *   auto-save, so the workspace's in-memory lists stay current (the explorer
 *   reads a diagram's name from its source and a note's from its markdown).
 */
export function useTabs(
  repo: WorkspaceRepository,
  selectedDocument: TabDocument | null,
  onDocumentEdit?: (document: TabDocument) => void,
): TabsHook {
  const [tabSet, setTabSet] = useState<TabSet>(createEmptyTabSet);
  // The editor buffer is first-class so editing works even before any document is
  // loaded into a tab (the preview stays live on the seeded sample).
  const [source, setSource] = useState<string>(SAMPLE_SOURCE);
  // Which document `source` currently belongs to. The selection effect uses it to
  // tell "the user picked a different document" (adopt its content) from "the
  // same document was edited" (never overwrite the buffer).
  const bufferRef = useRef<string | null>(null);
  // Writes already started, keyed by document + exact buffer. The tab's own
  // `savedSource` cannot dedupe the async window between firing a save and the
  // save landing, so this closes that gap.
  const inFlightRef = useRef<Set<string>>(new Set());

  const activeTabId = tabSet.activeTabId;

  // Open (or activate) the document the workspace selected. A layout effect so
  // the strip is in step with the selection before the browser paints: moving
  // between a diagram and a note never flashes the other document's buffer.
  useLayoutEffect(() => {
    if (!selectedDocument) return;
    if (bufferRef.current === selectedDocument.id) return;
    bufferRef.current = selectedDocument.id;
    setTabSet((current) => openDocumentInSet(current, selectedDocument));
    setSource(selectedDocument.source);
  }, [selectedDocument]);

  const activateTab = useCallback(
    (documentId: string) => {
      const target = tabSet.tabs.find((tab) => tab.id === documentId);
      setTabSet((current) => activateTabInSet(current, documentId));
      if (target) {
        bufferRef.current = documentId;
        setSource(target.source);
      }
    },
    [tabSet],
  );

  const closeTab = useCallback(
    (documentId: string) => {
      const next = closeTabInSet(tabSet, documentId);
      setTabSet(next);
      // Keep the editor showing a real document. Closing an inactive tab leaves
      // the buffer alone; closing the active one follows the neighbour the strip
      // activates. With no tabs left the buffer stays as-is, so nothing the user
      // is reading disappears mid-close.
      const nextActive = getActiveTab(next);
      if (nextActive && nextActive.id !== bufferRef.current) {
        bufferRef.current = nextActive.id;
        setSource(nextActive.source);
      } else if (!nextActive && tabSet.activeTabId === documentId) {
        bufferRef.current = null;
      }
    },
    [tabSet],
  );

  const closeActiveTab = useCallback(() => {
    if (activeTabId) closeTab(activeTabId);
  }, [activeTabId, closeTab]);

  const openDocument = useCallback((document: TabDocument) => {
    bufferRef.current = document.id;
    setTabSet((current) => openDocumentInSet(current, document));
    setSource(document.source);
  }, []);

  const openDiagram = useCallback(
    (diagram: DiagramFile) => openDocument(tabDocumentOfDiagram(diagram)),
    [openDocument],
  );

  const openNote = useCallback(
    (note: NoteFile) => openDocument(tabDocumentOfNote(note)),
    [openDocument],
  );

  const updateActiveSource = useCallback((next: string) => {
    setSource(next);
    setTabSet((current) => {
      const active = getActiveTab(current);
      // With no tab open the buffer is still live (the seeded sample) but there is
      // nothing to persist it into; the workspace saves only tab-backed files.
      return active ? updateTabSource(current, active.id, next) : current;
    });
  }, []);

  const applyExternalDocument = useCallback((document: TabDocument) => {
    setTabSet((current) => replaceDocument(current, document));
    if (bufferRef.current === document.id) setSource(document.source);
  }, []);

  const applyExternalDiagram = useCallback(
    (diagram: DiagramFile) =>
      applyExternalDocument(tabDocumentOfDiagram(diagram)),
    [applyExternalDocument],
  );

  const applyExternalNote = useCallback(
    (note: NoteFile) => applyExternalDocument(tabDocumentOfNote(note)),
    [applyExternalDocument],
  );

  // Auto-save: persist the active tab's buffer whenever it changes and is not
  // already the saved content. Runs in an effect (not a state updater) so the
  // side effect stays out of render, and records success back into the tab so
  // the dirty flag clears without a round-trip to storage.
  useEffect(() => {
    const active = getActiveTab(tabSet);
    if (!active) return;
    if (active.source === active.savedSource) return;
    const key = writeKey(active);
    if (inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);

    const document: TabDocument = {
      kind: active.kind,
      id: active.documentId,
      projectId: active.projectId,
      name: active.name,
      source: active.source,
    };

    void (async () => {
      const result = await persistDocument(repo, document);
      inFlightRef.current.delete(key);
      if (!isOk(result)) return;
      // Record exactly what was written: an edit that arrived during the write
      // keeps the tab dirty so the next pass persists it too.
      setTabSet((current) =>
        markTabSaved(current, document.id, document.source),
      );
      onDocumentEdit?.(document);
    })();
  }, [tabSet, repo, onDocumentEdit]);

  return {
    tabs: tabSet.tabs,
    activeTabId,
    activeTab: getActiveTab(tabSet),
    source,
    openDocument,
    openDiagram,
    openNote,
    activateTab,
    closeTab,
    closeActiveTab,
    updateActiveSource,
    applyExternalDiagram,
    applyExternalNote,
  };
}
