/**
 * Application shell (Phase 0).
 *
 * This is intentionally minimal. Later phases will replace the placeholder
 * regions below with the real explorer, editor, and preview panes. The layout
 * skeleton (three-pane IDE style) is kept so later work drops into a stable
 * structure.
 */

const PRODUCT_NAME = "SequenceDiagrams Manager";

export default function App() {
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
          <span className="app__placeholder">Project explorer</span>
        </section>
        <section
          className="app__pane app__pane--editor"
          aria-label="DSL editor"
        >
          <span className="app__placeholder">Editor</span>
        </section>
        <section
          className="app__pane app__pane--preview"
          aria-label="Diagram preview"
        >
          <span className="app__placeholder">Preview</span>
        </section>
      </main>
      <footer className="app__statusbar">
        <span>{PRODUCT_NAME}</span>
      </footer>
    </div>
  );
}
