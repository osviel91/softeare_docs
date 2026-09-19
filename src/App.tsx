/**
 * Application shell (Phase 3).
 *
 * App is the single source of truth for the DSL source. It runs the language
 * analysis once (memoized via {@link useDiagram}) and feeds the result to both
 * the editor and the preview, so editing and rendering stay in lockstep. The
 * explorer pane is left for a later phase.
 */
import { useState } from "react";
import Editor from "./features/editor/Editor";
import Preview from "./features/preview/Preview";
import { useDiagram } from "./features/preview/use-diagram";
import { SAMPLE_SOURCE } from "./sample-source";

const PRODUCT_NAME = "SequenceDiagrams Manager";

export default function App() {
  const [source, setSource] = useState<string>(SAMPLE_SOURCE);
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
          <span className="app__placeholder">Project explorer</span>
        </section>
        <section
          className="app__pane app__pane--editor"
          aria-label="DSL editor"
        >
          <Editor
            value={source}
            onChange={setSource}
            diagnostics={diagnostics}
          />
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
