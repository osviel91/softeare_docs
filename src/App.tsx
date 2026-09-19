/**
 * Application shell (Phase 4 + Phase 5).
 *
 * App owns the workspace repository and feeds its state to every pane. The
 * explorer manages projects and diagram selection; the editor edits the current
 * diagram, saving changes back through {@link WorkspaceHook.saveCurrentDiagram};
 * the preview renders whatever source is current. The workspace hook seeds the
 * editor with a valid sample diagram on first render, so the preview is populated
 * before the async load resolves.
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
import { useWorkspace } from "./features/explorer/use-workspace";
import { useWorkspaceRepository } from "./features/explorer/workspace-factory";
import { useDiagram } from "./features/preview/use-diagram";
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

  const {
    projects,
    diagrams,
    selectedProjectId,
    selectedDiagramId,
    source,
    isLoading,
    error,
    loadDiagram,
    saveCurrentDiagram,
    createProject,
    deleteProject,
  } = useWorkspace(activeRepo);

  const { diagnostics } = useDiagram(source);

  return (
    <div className="app" data-testid="app-shell">
      <header className="app__toolbar">
        <span className="app__brand">{PRODUCT_NAME}</span>
      </header>
      <main className="app__workspace">
        <section
          className="app__pane app__pane--explorer"
          aria-label="Project explorer"
        >
          <Explorer
            projects={projects}
            diagrams={diagrams}
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
            <Editor
              value={source}
              onChange={(next) => {
                void saveCurrentDiagram(next);
              }}
              diagnostics={diagnostics}
            />
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
    </div>
  );
}
