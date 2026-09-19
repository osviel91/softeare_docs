/**
 * DSL editor (Phase 3).
 *
 * A thin, framework-shaped wrapper around a `<textarea>`. It owns no diagram
 * state of its own — it receives the current source via `value` and reports
 * changes through `onChange`, so the parent (App) stays the single source of
 * truth. Diagnostics from the language layer are surfaced below the textarea so
 * the editor stays usable while malformed input is being typed.
 */
import type { Diagnostic } from "../../language/diagnostics/diagnostics";
import { formatDiagnostic } from "../../language/diagnostics/diagnostics";

export interface EditorProps {
  /** The current DSL source. */
  value: string;
  /** Called with the new source whenever the user edits the textarea. */
  onChange: (value: string) => void;
  /** Diagnostics to surface below the editor (from the language layer). */
  diagnostics?: Diagnostic[];
}

export default function Editor({
  value,
  onChange,
  diagnostics = [],
}: EditorProps) {
  return (
    <div className="editor" data-testid="dsl-editor">
      <label className="editor__label" htmlFor="dsl-input">
        Sequence DSL
      </label>
      <textarea
        id="dsl-input"
        className="editor__textarea"
        data-testid="dsl-textarea"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="participant User
participant API

User -> API: Login"
      />
      <DiagnosticsList diagnostics={diagnostics} />
    </div>
  );
}

/** A labeled diagnostics list; renders nothing when there are no issues. */
function DiagnosticsList({ diagnostics }: { diagnostics: Diagnostic[] }) {
  if (diagnostics.length === 0) {
    return <p className="editor__ok">No problems detected.</p>;
  }

  return (
    <ul className="editor__diagnostics" data-testid="dsl-diagnostics">
      {diagnostics.map((diagnostic, index) => (
        <li
          key={`${diagnostic.code}-${index}`}
          className={`editor__diagnostic editor__diagnostic--${diagnostic.severity}`}
          title={formatDiagnostic(diagnostic)}
        >
          <span className="editor__diagnostic-severity">
            {diagnostic.severity}
          </span>
          <span className="editor__diagnostic-message">
            {formatDiagnostic(diagnostic)}
          </span>
        </li>
      ))}
    </ul>
  );
}
