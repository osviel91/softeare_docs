/**
 * Application shell (Phase 4).
 *
 * App owns the workspace repository and feeds its state to every pane. The
 * explorer manages projects and diagram selection; the editor edits the current
 * diagram, saving changes back through {@link WorkspaceHook.saveCurrentDiagram};
 * the preview renders whatever source is current. The workspace hook seeds the
 * editor with a valid sample diagram on first render, so the preview is populated
 * before the async load resolves.
 */
import Editor from "./features/editor/Editor";
import Preview from "./features/preview/Preview";
import Explorer from "./features/explorer/Explorer";
import { useWorkspace } from "./features/explorer/use-workspace";
import { useWorkspaceRepository } from "./features/explorer/workspace-factory";
import { useDiagram } from "./features/preview/use-diagram";

const PRODUCT_NAME = "SequenceDiagrams Manager";

export default function App() {
  const repo = useWorkspaceRepository();
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
  } = useWorkspace(repo);

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
