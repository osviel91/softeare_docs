/**
 * DSL editor.
 *
 * A thin, framework-shaped wrapper around a `<textarea>` plus a line-number
 * gutter and a snippet menu. It owns no diagram state of its own — it receives
 * the current source via `value` and reports changes through `onChange`, so the
 * parent (App) stays the single source of truth. Diagnostics from the language
 * layer are surfaced below the textarea so the editor stays usable while
 * malformed input is being typed.
 *
 * The gutter is decorative: it mirrors the textarea's scroll position and line
 * count, and is hidden from assistive technology since the textarea already
 * exposes the real content.
 */
import { useEffect, useMemo, useRef, useState } from "react";
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

/** Reusable DSL fragments offered by the snippet menu. */
export const SNIPPETS: { label: string; hint: string; text: string }[] = [
  {
    label: "Participants",
    hint: "declare lifelines",
    text: "participant User\nparticipant API",
  },
  {
    label: "Alias",
    hint: "shorthand for a participant",
    text: "alias U = User",
  },
  { label: "Message", hint: "solid arrow", text: "User -> API: Request" },
  { label: "Response", hint: "dashed arrow", text: "API --> User: Response" },
  {
    label: "Note",
    hint: "callout on a lifeline",
    text: "note right of API : Detail",
  },
  {
    label: "Activation",
    hint: "busy span on a lifeline",
    text: "activate API\nAPI -> API: Work\ndeactivate API",
  },
];

export default function Editor({
  value,
  onChange,
  diagnostics = [],
}: EditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  // Caret to restore after a snippet insertion re-renders the controlled value.
  const pendingCaret = useRef<number | null>(null);

  const lineCount = useMemo(() => value.split("\n").length, [value]);

  // Restore the caret after the parent has applied the inserted text.
  useEffect(() => {
    const caret = pendingCaret.current;
    const textarea = textareaRef.current;
    if (caret === null || !textarea) return;
    pendingCaret.current = null;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  });

  /** Keep the gutter aligned with the textarea's own scrolling. */
  const syncScroll = (element: HTMLTextAreaElement) => {
    if (gutterRef.current) {
      gutterRef.current.scrollTop = element.scrollTop;
    }
  };

  const insertSnippet = (text: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    // Start the fragment on its own line unless it is already at a line start.
    const prefix = before === "" || before.endsWith("\n") ? "" : "\n";
    const inserted = `${prefix}${text}`;
    pendingCaret.current = start + inserted.length;
    onChange(`${before}${inserted}${value.slice(end)}`);
    setSnippetsOpen(false);
  };

  return (
    <div className="editor" data-testid="dsl-editor">
      <div className="editor__code">
        <div
          ref={gutterRef}
          className="editor__gutter"
          data-testid="editor-gutter"
          aria-hidden="true"
        >
          {Array.from({ length: lineCount }, (_, index) => (
            <span key={index} className="editor__line-number">
              {index + 1}
            </span>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          id="dsl-input"
          className="editor__textarea"
          data-testid="dsl-textarea"
          aria-label="Sequence DSL"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => syncScroll(event.currentTarget)}
          placeholder="participant User
participant API

User -> API: Login"
        />
      </div>

      <div className="editor__footer">
        <div className="snippets">
          <button
            type="button"
            className="button button--ghost"
            data-testid="snippets-button"
            aria-expanded={snippetsOpen}
            aria-haspopup="menu"
            onClick={() => setSnippetsOpen((open) => !open)}
          >
            <span aria-hidden="true">{"[ ]"}</span> Snippets
          </button>
          {snippetsOpen && (
            <ul
              className="snippets__menu"
              data-testid="snippets-menu"
              role="menu"
            >
              {SNIPPETS.map((snippet) => (
                <li key={snippet.label}>
                  <button
                    type="button"
                    className="snippets__item"
                    data-testid="snippet-item"
                    role="menuitem"
                    onClick={() => insertSnippet(snippet.text)}
                  >
                    <span className="snippets__label">{snippet.label}</span>
                    <span className="snippets__hint">{snippet.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <span className="editor__count" data-testid="editor-line-count">
          {lineCount} line{lineCount === 1 ? "" : "s"}
        </span>
      </div>

      <DiagnosticsList diagnostics={diagnostics} />
    </div>
  );
}

/** A labeled diagnostics list; renders a clean-state hint when there is none. */
function DiagnosticsList({ diagnostics }: { diagnostics: Diagnostic[] }) {
  if (diagnostics.length === 0) {
    return (
      <p className="editor__ok" data-testid="dsl-ok">
        No problems detected.
      </p>
    );
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
