/**
 * Tab state hook (Phase 6).
 *
 * `useTabs` owns the open-tab set and the source shown in the editor/preview. It
 * is fed by {@link useWorkspace}: selecting a diagram in the explorer opens (or
 * activates) that diagram's tab, and editing the source auto-saves back through
 * the active tab's own project and id. The preview derives from the same
 * `source`, so the editor and preview stay in lockstep.
 *
 * A tab is always backed by a saved {@link DiagramFile} — there are no scratch
 * tabs. Because the editor auto-saves on every edit (see App), a tab's buffer is
 * simply what the user last typed; switching tabs preserves each diagram's
 * in-progress edits without extra bookkeeping.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DiagramFile } from "../../domain/workspace/types";
import type { WorkspaceRepository } from "../../workspace/WorkspaceRepository";
import { SAMPLE_SOURCE } from "../../sample-source";
import type { Tab, TabSet } from "./tabs";
import {
  activateDiagram as activateTabInSet,
  closeDiagram as closeTabInSet,
  createEmptyTabSet,
  getActiveTab,
  openDiagram as openTabInSet,
  updateTabSource,
} from "./tabs";

/** The state and actions exposed by {@link useTabs}. */
export interface TabsHook {
  /** Every open tab, in the order they were opened. */
  tabs: Tab[];
  /** The id of the active tab, or `null` when none is open. */
  activeTabId: string | null;
  /** The editor/preview source. First-class so editing works before any tab is
   * open; each open tab's buffer mirrors it so switching preserves edits. */
  source: string;
  /**
   * Open (or activate) a tab for a diagram and show its source. Called by the
   * "New diagram" command, which creates a file before it exists in any tab.
   */
  openDiagram(diagram: DiagramFile): void;
  /** Activate a tab without loading its project; called by the tab bar. */
  activateTab(diagramId: string): void;
  /** Close a tab; called by a tab's close button. */
  closeTab(diagramId: string): void;
  /** Close the active tab (no-op when none is open). */
  closeActiveTab: () => void;
  /** Called by the editor with new source for the active tab (auto-saves). */
  updateActiveSource(source: string): void;
}

/**
 * Bind the open-tab set to the workspace repository.
 *
 * @param repo - The active workspace repository, used to persist edits.
 * @param selectedDiagram - The diagram the explorer loaded; opening it creates or
 *   activates its tab. `null` while the async load is in flight, so the editor
 *   falls back to the seeded sample until a real diagram loads.
 */
export function useTabs(
  repo: WorkspaceRepository,
  selectedDiagram: DiagramFile | null,
): TabsHook {
  const [tabSet, setTabSet] = useState<TabSet>(createEmptyTabSet);
  // The editor source is first-class so editing works even before any diagram is
  // loaded into a tab (the preview stays live on the seeded sample). Each open
  // tab's buffer mirrors this so switching back preserves that diagram's edits.
  const [source, setSource] = useState<string>(SAMPLE_SOURCE);
  // The last source persisted for the active tab, so we save each unique buffer
  // once instead of on every render. Because edits auto-save, a tab's buffer is
  // always its last-saved source, so switching tabs never rewrites stale content.
  const savedSourceRef = useRef<string | null>(null);

  // Open the diagram the explorer selected into a tab. Runs on mount and whenever
  // the selection changes; while the async load is in flight `selectedDiagram` is
  // null, so no tab exists yet and the editor keeps the seeded sample. The source
  // is set explicitly so the editor shows the loaded diagram, not a stale edit.
  useEffect(() => {
    if (!selectedDiagram) return;
    setTabSet((current) => openTabInSet(current, selectedDiagram));
    setSource(selectedDiagram.source);
    // The loaded content is already persisted, so mark it saved to avoid a
    // redundant write on the first auto-save pass.
    savedSourceRef.current = selectedDiagram.source;
  }, [selectedDiagram]);

  const activeTabId = tabSet.activeTabId;

  const activateTab = useCallback(
    (diagramId: string) => {
      setTabSet((current) => activateTabInSet(current, diagramId));
      // Sync the editor source to the activated tab's buffer. `tabSet` is the
      // current render's value; the functional update above sets the state.
      const target = tabSet.tabs.find((tab) => tab.id === diagramId);
      if (target) setSource(target.source);
    },
    [tabSet],
  );

  const closeTab = useCallback((diagramId: string) => {
    setTabSet((current) => closeTabInSet(current, diagramId));
  }, []);

  // Close the active tab. Guarded on `activeTabId` so it is a no-op when no tab
  // is open; `closeTab` is stable, so this method is too.
  const closeActiveTab = useCallback(() => {
    if (activeTabId) closeTab(activeTabId);
  }, [activeTabId, closeTab]);

  // Open (or activate) a tab for a diagram and mirror its source into the
  // editor. Idempotent: opening an already-open tab just activates it, so the
  // "New diagram" command can call this unconditionally. Marking the buffer as
  // saved avoids a redundant write on the first auto-save pass.
  const openDiagram = useCallback((diagram: DiagramFile) => {
    setTabSet((current) => openTabInSet(current, diagram));
    setSource(diagram.source);
    savedSourceRef.current = diagram.source;
  }, []);

  const updateActiveSource = useCallback((nextSource: string) => {
    setSource(nextSource);
    setTabSet((current) =>
      updateTabSource(current, current.activeTabId ?? "", nextSource),
    );
  }, []);

  // Auto-save: persist the active tab's buffer whenever it changes. Runs in an
  // effect (not a state updater) so the side effect stays out of render. The ref
  // dedupes, so identical consecutive buffers are written only once.
  useEffect(() => {
    const active = getActiveTab(tabSet);
    if (!active) return;
    if (savedSourceRef.current === active.source) return;
    savedSourceRef.current = active.source;
    void repo.saveDiagramFile(active.projectId, {
      id: active.diagramId,
      name: active.title,
      source: active.source,
      projectId: active.projectId,
    });
  }, [tabSet, repo, activeTabId]);

  return {
    tabs: tabSet.tabs,
    activeTabId,
    source,
    openDiagram,
    activateTab,
    closeTab,
    closeActiveTab,
    updateActiveSource,
  };
}
