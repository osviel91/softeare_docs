/**
 * Application shell (Phase 4 + Phase 5 + Phase 6).
 *
 * App owns the workspace repository and feeds its state to every pane. The
 * explorer manages projects and diagram selection; selecting a diagram opens (or
 * activates) a tab. The editor edits the active tab's source, which is auto-saved
 * back through {@link useTabs}; the preview renders that same source. Tabs own the
 * editor source, so several diagrams can be open at once and switching between
 * them preserves each one's in-progress edits.
 *
 * Two backends are supported and swapped through a single active repository:
 *
 * - In-browser projects (IndexedDB, Phase 4) when no folder is open.
 * - A local folder the user opens via the File System Access API (Phase 5).
 *
 * `openedFolder` is `null` by default; clicking "Open folder…" replaces the active
 * repository with the folder-backed one, and "Close folder" restores the default.
 */
import { useCallback, useState } from "react";
import Editor from "./features/editor/Editor";
import Preview from "./features/preview/Preview";
import Explorer from "./features/explorer/Explorer";
import TabBar from "./features/tabs/TabBar";
import { useWorkspace } from "./features/explorer/use-workspace";
import { useWorkspaceRepository } from "./features/explorer/workspace-factory";
import { useTabs } from "./features/tabs/use-tabs";
import { useDiagram } from "./features/preview/use-diagram";
import { useCommandPalette } from "./features/commands/use-command-palette";
import { useCommands } from "./features/commands/use-commands";
import CommandPalette from "./features/commands/CommandPalette";
import type { Command } from "./features/commands/command";
import {
  openFileSystemRepository,
  supportsFileSystemAccess,
  type OpenedFolder,
} from "./workspace/fs-access/create-file-system-repository";
import type { WorkspaceRepository } from "./workspace/WorkspaceRepository";

const PRODUCT_NAME = "SequenceDiagrams Manager";

export default function App() {
  const defaultRepo = useWorkspaceRepository();
  const [openedFolder, setOpenedFolder] = useState<OpenedFolder | null>(null);

  /**
   * Open a local folder (replacing the active repository) or, when a folder is
   * already open, close it and return to in-browser projects. A cancelled picker
   * leaves the current repository untouched by resetting to `null`.
   */
  const openFolder = useCallback(async () => {
    if (openedFolder) {
      setOpenedFolder(null);
      return;
    }
    try {
      setOpenedFolder(await openFileSystemRepository());
    } catch {
      setOpenedFolder(null);
    }
  }, [openedFolder]);

  const activeRepo: WorkspaceRepository =
    openedFolder?.repository ?? defaultRepo;

  const workspace = useWorkspace(activeRepo);
  const {
    projects,
    diagrams,
    allDiagrams,
    selectedProjectId,
    selectedDiagramId,
    selectedDiagram,
    isLoading,
    error,
    loadDiagram,
    createProject,
    deleteProject,
  } = workspace;

  // Tabs own the editor source (and auto-save it), so the editor/preview derive
  // from the active tab rather than from the workspace hook. The full hook is
  // passed to the command registry, which needs openDiagram/closeTab too; the
  // array is destructured for the TabBar.
  const tabsHook = useTabs(activeRepo, selectedDiagram);
  const {
    tabs,
    activeTabId,
    source,
    activateTab,
    closeTab,
    updateActiveSource,
  } = tabsHook;

  const { diagnostics } = useDiagram(source);

  // Command palette: open state/shortcut, and the registry built from current
  // workspace + tab state. `runCommand` runs the selected command through the
  // registry (single choke point) and dismisses the palette.
  const { isOpen, open, close } = useCommandPalette();
  const registry = useCommands({
    createEmptyDiagram: workspace.createEmptyDiagram,
    selectedProjectId,
    openDiagram: tabsHook.openDiagram,
    closeActiveTab: tabsHook.closeActiveTab,
    openFolder,
    folderOpen: openedFolder !== null,
    folderSupported: supportsFileSystemAccess(),
  });

  const runCommand = useCallback(
    (command: Command) => {
      registry.run(command.id);
      close();
    },
    [registry, close],
  );

  return (
    <div className="app" data-testid="app-shell">
      <header className="app__toolbar">
        <span className="app__brand">{PRODUCT_NAME}</span>
        <button
          type="button"
          className="app__command-button"
          data-testid="command-palette-button"
          aria-label="Open command palette"
          onClick={open}
        >
          Commands…
        </button>
      </header>
      <main className="app__workspace">
        <section
          className="app__pane app__pane--explorer"
          aria-label="Project explorer"
        >
          <Explorer
            projects={projects}
            diagrams={diagrams}
            allDiagrams={allDiagrams}
            selectedProjectId={selectedProjectId}
            selectedDiagramId={selectedDiagramId}
            isLoading={isLoading}
            onCreateProject={createProject}
            onDeleteProject={deleteProject}
            onLoadDiagram={loadDiagram}
            onOpenFolder={openFolder}
            folderName={openedFolder?.folderName ?? null}
            folderSupported={supportsFileSystemAccess()}
          />
        </section>
        <section
          className="app__pane app__pane--editor"
          aria-label="DSL editor"
        >
          {error ? (
            <p className="editor__error" data-testid="workspace-error">
              Could not load your local projects: {error.message}
            </p>
          ) : (
            <>
              <TabBar
                tabs={tabs}
                activeTabId={activeTabId}
                onActivateTab={activateTab}
                onCloseTab={closeTab}
              />
              <Editor
                value={source}
                onChange={updateActiveSource}
                diagnostics={diagnostics}
              />
            </>
          )}
        </section>
        <section
          className="app__pane app__pane--preview"
          aria-label="Diagram preview"
        >
          <Preview source={source} />
        </section>
      </main>
      <footer className="app__statusbar">
        <span>{PRODUCT_NAME}</span>
      </footer>

      {isOpen && (
        <CommandPalette
          registry={registry}
          onRun={runCommand}
          onClose={close}
        />
      )}
    </div>
  );
}
