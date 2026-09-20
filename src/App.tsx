/**
 * Application shell.
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
 * - In-browser projects (IndexedDB) when no folder is open.
 * - A local folder the user opens via the File System Access API.
 *
 * The editor pane has two views (`code` / `docs`): the DSL source and a reference
 * for the language. The preview tracks the source while auto-update is on; with it
 * off the canvas is frozen until the user renders, which keeps a large diagram
 * from re-laying out on every keystroke.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Editor from "./features/editor/Editor";
import Preview from "./features/preview/Preview";
import Explorer from "./features/explorer/Explorer";
import TabBar from "./features/tabs/TabBar";
import DslReference from "./features/docs/DslReference";
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

/** Which view the editor pane shows. */
type EditorView = "code" | "docs";

export default function App() {
  const defaultRepo = useWorkspaceRepository();
  const [openedFolder, setOpenedFolder] = useState<OpenedFolder | null>(null);
  const [view, setView] = useState<EditorView>("code");
  const [autoUpdate, setAutoUpdate] = useState(true);
  // The source the preview is actually showing. While auto-update is on this
  // tracks the editor; while it is off it only moves when the user renders.
  const [renderedSource, setRenderedSource] = useState("");

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

  const { ast, diagnostics } = useDiagram(source);

  // Keep the displayed source in step with the editor while auto-update is on.
  // Seeding from an empty string means the first render always syncs.
  useEffect(() => {
    if (autoUpdate) setRenderedSource(source);
  }, [autoUpdate, source]);

  const isStale = renderedSource !== source;

  // Counts for the status bar, derived from the same analysis the panes use.
  const counts = useMemo(() => {
    if (!ast) return { participants: 0, messages: 0 };
    return {
      participants: ast.participants.length,
      messages: ast.statements.filter((s) => s.type === "message").length,
    };
  }, [ast]);

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;

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
        <span className="app__brand">
          <span className="app__brand-mark" aria-hidden="true">
            {"</>"}
          </span>
          {PRODUCT_NAME}
        </span>

        <div
          className="segmented"
          role="tablist"
          aria-label="Editor view"
          data-testid="editor-view-toggle"
        >
          <button
            type="button"
            role="tab"
            className={`segmented__option${view === "code" ? " segmented__option--active" : ""}`}
            data-testid="view-code"
            aria-selected={view === "code"}
            onClick={() => setView("code")}
          >
            <span aria-hidden="true">{"</>"}</span> Code
          </button>
          <button
            type="button"
            role="tab"
            className={`segmented__option${view === "docs" ? " segmented__option--active" : ""}`}
            data-testid="view-docs"
            aria-selected={view === "docs"}
            onClick={() => setView("docs")}
          >
            <span aria-hidden="true">▤</span> Docs
          </button>
        </div>

        <label className="switch" title="Re-render the diagram as you type">
          <input
            type="checkbox"
            className="switch__input"
            data-testid="auto-update-toggle"
            checked={autoUpdate}
            onChange={(event) => setAutoUpdate(event.target.checked)}
          />
          <span
            className="switch__track"
            data-testid="auto-update-switch"
            aria-hidden="true"
          >
            <span className="switch__thumb" />
          </span>
          <span className="switch__label">Auto-update</span>
        </label>

        <button
          type="button"
          className="button app__command-button"
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
          {view === "docs" ? (
            <DslReference />
          ) : error ? (
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
          <Preview
            source={renderedSource || source}
            autoUpdate={autoUpdate}
            isStale={isStale}
            onRender={() => setRenderedSource(source)}
          />
        </section>
      </main>

      <footer className="app__statusbar">
        <span className="app__status-item">{PRODUCT_NAME}</span>
        <span className="app__status-item" data-testid="status-participants">
          {counts.participants} participant
          {counts.participants === 1 ? "" : "s"}
        </span>
        <span className="app__status-item" data-testid="status-messages">
          {counts.messages} message{counts.messages === 1 ? "" : "s"}
        </span>
        <span
          className={`app__status-item app__status-item--${errorCount > 0 ? "error" : "ok"}`}
          data-testid="status-diagnostics"
        >
          {errorCount === 0
            ? "No problems"
            : `${errorCount} problem${errorCount === 1 ? "" : "s"}`}
        </span>
        <span className="app__status-spacer" />
        <span className="app__status-item app__status-item--muted">
          {autoUpdate ? "Live" : "Paused"}
        </span>
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
