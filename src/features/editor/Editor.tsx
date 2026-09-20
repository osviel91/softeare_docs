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
import type { DragEvent as ReactDragEvent, KeyboardEvent } from "react";
import { formatLocation } from "../../language/diagnostics/diagnostics";
import type { SourceRange } from "../../domain/diagram/ast";
import type { EditorReveal } from "./reveal";
import { useEditorReveal } from "./use-reveal";
import { positionToOffset } from "../../language/source-position";
import type { CompletionItem } from "../../domain/project/completion";
import type { HoverInfo } from "../../domain/project/hover";

/**
 * What the editor needs to *show* about a problem.
 *
 * Deliberately structural rather than either language's diagnostic type: the
 * editor renders a severity, a message and a location, and both the sequence and
 * the event-flow analysers produce that. Widening here is what lets one editor
 * serve two languages without a second component.
 */
export interface EditorDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  code: string;
  range?: SourceRange;
}

export interface EditorProps {
  /** The current DSL source. */
  value: string;
  /** Called with the new source whenever the user edits the textarea. */
  onChange: (value: string) => void;
  /** Diagnostics to surface below the editor (from the language layer). */
  diagnostics?: EditorDiagnostic[];
  /**
   * A source range to select and scroll to (used by project search, and by the
   * outline and problems panels). `null` leaves the caret alone.
   */
  reveal?: EditorReveal | null;
  /**
   * Semantic completions for the caret. Given the buffer and an offset, return
   * what could go there — keywords and participant names in the DSL. Supplied by
   * the shell, which is what has the project index; the editor only renders the
   * popup and applies the accepted text.
   */
  complete?: (request: { source: string; offset: number }) => CompletionItem[];
  /** The facts to show for whatever sits at an offset, for the hover card. */
  describe?: (offset: number) => HoverInfo | null;
  /** Called with the caret's offset whenever it moves, for editor→preview sync. */
  onCaretChange?: (offset: number) => void;
}

/** Reusable DSL fragments offered by the snippet menu. */
export const SNIPPETS: { label: string; hint: string; text: string }[] = [
  {
    label: "Title",
    hint: "name the diagram",
    text: "title My Diagram",
  },
  {
    label: "Participants",
    hint: "declare lifelines",
    text: "participant User\nparticipant API",
  },
  {
    label: "Actor",
    hint: "human lifeline",
    text: "actor User",
  },
  {
    label: "Labelled participant",
    hint: "stable id with a readable label",
    text: 'participant api as "Authentication Service"',
  },
  {
    label: "Alias",
    hint: "shorthand for a participant",
    text: "alias U = User",
  },
  {
    label: "Message",
    hint: "solid arrow with a head",
    text: "User ->> API: Request",
  },
  {
    label: "Response",
    hint: "dashed arrow with a head",
    text: "API -->> User: Response",
  },
  {
    label: "Self message",
    hint: "loop back onto one lifeline",
    text: "API ->> API: Validate token",
  },
  {
    label: "Note",
    hint: "callout on a lifeline",
    text: "note right of API : Detail",
  },
  {
    label: "Spanning note",
    hint: "covers several lifelines",
    text: "note over API,DB : Transaction boundary",
  },
  {
    label: "Multiline note",
    hint: "body closed by end note",
    text: "note right of API:\n  First line\n  Second line\nend note",
  },
  {
    label: "Note on message",
    hint: "attach to step number N",
    text: "note on 1 : Detail",
  },
  {
    label: "Activation",
    hint: "busy span on a lifeline",
    text: "activate API\nAPI ->> API: Work\ndeactivate API",
  },
  {
    label: "Inline activation",
    hint: "+ activates receiver, - deactivates sender",
    text: "User ->>+ API: Login\nAPI -->>- User: Token",
  },
  {
    label: "Loop",
    hint: "repeat a block",
    text: "loop retry up to 3 times\n  API ->> DB: Query\nend",
  },
  {
    label: "Alt / else",
    hint: "alternative branches",
    text: "alt user exists\n  API ->> DB: Load user\nelse user missing\n  API -->> User: 404\nend",
  },
  {
    label: "Opt",
    hint: "optional block",
    text: "opt cache hit\n  API -->> User: Cached\nend",
  },
  {
    label: "Par / and",
    hint: "parallel blocks",
    text: "par send email\n  API ->> Mail: Notify\nand write audit\n  API ->> DB: Log\nend",
  },
  {
    label: "Critical / option",
    hint: "critical region with fallback",
    text: "critical commit\n  API ->> DB: Commit\noption rollback\n  API ->> DB: Rollback\nend",
  },
  {
    label: "Break",
    hint: "interruption flow",
    text: "break request rejected\n  API -->> User: 400 Bad Request\nend",
  },
];

export default function Editor({
  value,
  onChange,
  diagnostics = [],
  reveal = null,
  complete,
  describe,
  onCaretChange,
}: EditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  // True while a drag is hovering the textarea, so it can show a drop hint.
  const [isDropTarget, setIsDropTarget] = useState(false);
  // Caret to restore after a snippet insertion re-renders the controlled value.
  const pendingCaret = useRef<number | null>(null);

  // Selecting a requested range is shared with the markdown editor.
  useEditorReveal(textareaRef, reveal, value);

  const lineCount = useMemo(() => value.split("\n").length, [value]);

  // --- Semantic completion and hover -------------------------------------
  // Both are props rather than state because the *facts* come from the project
  // index, which only the shell has. The editor owns the popup, the caret, and
  // the pointer; it never decides what a name means.
  const [completions, setCompletions] = useState<CompletionItem[]>([]);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [hover, setHover] = useState<{
    info: HoverInfo;
    x: number;
    y: number;
  } | null>(null);
  // Character width of the editor's monospace font, measured once. Mapping a
  // pointer position back to a character offset in a textarea needs it, and the
  // computed style is the only honest source for it.
  const charWidthRef = useRef<number | null>(null);

  const caretOffset = (textarea: HTMLTextAreaElement): number =>
    textarea.selectionStart ?? 0;

  /** Refresh the completion list for the caret's current position. */
  const refreshCompletions = (textarea: HTMLTextAreaElement) => {
    const offset = caretOffset(textarea);
    onCaretChange?.(offset);
    if (!complete) return;
    setCompletions(complete({ source: value, offset }));
    setCompletionIndex(0);
  };

  /** Insert a completion, replacing the word the user was typing. */
  const acceptCompletion = (item: CompletionItem) => {
    const textarea = textareaRef.current;
    const text = item.insertText ?? item.label;
    pendingCaret.current = item.replaceStart + text.length;
    setCompletions([]);
    onChange(
      `${value.slice(0, item.replaceStart)}${text}${value.slice(item.replaceEnd)}`,
    );
    textarea?.focus();
  };

  /** Measure one character of the textarea's font, caching the result. */
  const charWidth = (textarea: HTMLTextAreaElement): number => {
    if (charWidthRef.current !== null) return charWidthRef.current;
    const probe = document.createElement("span");
    const style = window.getComputedStyle(textarea);
    probe.style.font = style.font;
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.whiteSpace = "pre";
    probe.textContent = "0".repeat(50);
    document.body.append(probe);
    const measured = probe.getBoundingClientRect().width / 50;
    probe.remove();
    charWidthRef.current = measured > 0 ? measured : 8;
    return charWidthRef.current;
  };

  /** The character offset under a pointer position in the textarea. */
  const offsetFromPoint = (
    textarea: HTMLTextAreaElement,
    clientX: number,
    clientY: number,
  ): number => {
    const style = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(style.lineHeight) || 18;
    const padTop = Number.parseFloat(style.paddingTop) || 0;
    const padLeft = Number.parseFloat(style.paddingLeft) || 0;
    const rect = textarea.getBoundingClientRect();
    const line = Math.max(
      0,
      Math.floor(
        (clientY - rect.top + textarea.scrollTop - padTop) / lineHeight,
      ),
    );
    const column = Math.max(
      0,
      Math.round(
        (clientX - rect.left + textarea.scrollLeft - padLeft) /
          charWidth(textarea),
      ),
    );
    return positionToOffset(value, { line, column });
  };

  /** Keyboard handling for the completion popup, before the textarea sees it. */
  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (completions.length === 0) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setCompletionIndex((index) => (index + 1) % completions.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setCompletionIndex(
          (index) => (index - 1 + completions.length) % completions.length,
        );
        break;
      case "Tab":
      case "Enter": {
        const chosen = completions[completionIndex];
        if (!chosen) return;
        event.preventDefault();
        acceptCompletion(chosen);
        break;
      }
      case "Escape":
        event.preventDefault();
        setCompletions([]);
        break;
      default:
        break;
    }
  };

  // Clear a completion list that no longer applies once focus leaves the editor.
  useEffect(() => {
    if (!complete) setCompletions([]);
  }, [complete]);

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

  /** Insert `text` at the caret (or replace the selection) and restore it after. */
  const insertAtCaret = (text: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    pendingCaret.current = start + text.length;
    onChange(`${value.slice(0, start)}${text}${value.slice(end)}`);
  };

  const insertSnippet = (text: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const before = value.slice(0, start);
    // Start the fragment on its own line unless it is already at a line start.
    const prefix = before === "" || before.endsWith("\n") ? "" : "\n";
    insertAtCaret(`${prefix}${text}`);
    setSnippetsOpen(false);
  };

  // Accept a participant name dragged out of the preview. The viewport puts the
  // participant id on the drag payload, so dropping it here writes the name the
  // DSL understands at the caret instead of making the user retype it.
  const onDragOver = (event: ReactDragEvent<HTMLTextAreaElement>) => {
    if (!event.dataTransfer?.types.includes("text/plain")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDropTarget(true);
  };

  const onDrop = (event: ReactDragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    setIsDropTarget(false);
    const text = event.dataTransfer?.getData("text/plain") ?? "";
    if (text.trim() === "") return;
    insertAtCaret(text.trim());
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
          className={`editor__textarea${
            isDropTarget ? " editor__textarea--drop" : ""
          }`}
          data-testid="dsl-textarea"
          aria-label="Sequence DSL"
          spellCheck={false}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            refreshCompletions(event.currentTarget);
          }}
          onKeyDown={onEditorKeyDown}
          onKeyUp={(event) => refreshCompletions(event.currentTarget)}
          onClick={(event) => refreshCompletions(event.currentTarget)}
          onBlur={() => setCompletions([])}
          onMouseMove={(event) => {
            if (!describe) return;
            const info = describe(
              offsetFromPoint(
                event.currentTarget,
                event.clientX,
                event.clientY,
              ),
            );
            setHover(
              info ? { info, x: event.clientX, y: event.clientY } : null,
            );
          }}
          onMouseLeave={() => setHover(null)}
          onScroll={(event) => syncScroll(event.currentTarget)}
          onDragOver={onDragOver}
          onDragLeave={() => setIsDropTarget(false)}
          onDrop={onDrop}
          placeholder="participant User
participant API

User -> API: Login"
        />
      </div>

      {completions.length > 0 && (
        <ul
          className="completions"
          data-testid="completions"
          role="listbox"
          aria-label="Suggestions"
        >
          {completions.map((item, index) => (
            <li
              key={`${item.kind}:${item.label}`}
              role="option"
              aria-selected={index === completionIndex}
            >
              <button
                type="button"
                className={`completions__item${
                  index === completionIndex ? " completions__item--active" : ""
                }`}
                data-testid="completion-item"
                data-kind={item.kind}
                // `onMouseDown` rather than `onClick`: the textarea blurs first
                // otherwise, and the popup would close before the click lands.
                onMouseDown={(event) => {
                  event.preventDefault();
                  acceptCompletion(item);
                }}
              >
                <span className="completions__label">{item.label}</span>
                {item.detail && (
                  <span className="completions__detail">{item.detail}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {hover && (
        <div
          className="hover-card"
          data-testid="hover-card"
          role="tooltip"
          style={{ left: `${hover.x + 12}px`, top: `${hover.y + 16}px` }}
        >
          <div className="hover-card__title" data-testid="hover-title">
            {hover.info.title}
          </div>
          <dl className="hover-card__rows">
            {hover.info.rows.map((row) => (
              <div key={row.label} className="hover-card__row">
                <dt>{row.label}</dt>
                <dd data-testid="hover-value">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

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

/** Format a diagnostic for display, prefixing its location when it has one. */
function formatEditorDiagnostic(diagnostic: EditorDiagnostic): string {
  return diagnostic.range
    ? `${formatLocation(diagnostic.range)}\n${diagnostic.message}`
    : diagnostic.message;
}

/** A labeled diagnostics list; renders a clean-state hint when there is none. */
function DiagnosticsList({ diagnostics }: { diagnostics: EditorDiagnostic[] }) {
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
          title={formatEditorDiagnostic(diagnostic)}
        >
          <span className="editor__diagnostic-severity">
            {diagnostic.severity}
          </span>
          <span className="editor__diagnostic-message">
            {formatEditorDiagnostic(diagnostic)}
          </span>
        </li>
      ))}
    </ul>
  );
}
