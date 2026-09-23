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
import type { SourceMention } from "../../domain/source-mention";
import { SEQUENCE_SNIPPETS, type EditorSnippet } from "./snippets";
import { highlightSegments } from "./highlight";
import { applyLiveRename } from "./live-rename";

/** A shared empty list, so a missing prop does not churn memo dependencies. */
const NO_MENTIONS: readonly SourceMention[] = [];

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
  /**
   * The snippet menu's fragments. The two documentation languages share no
   * statements below `title`, so the shell passes the set that matches the open
   * document; the sequence list is the default.
   */
  snippets?: EditorSnippet[];
  /**
   * The diagram's circled step numbers, keyed by 0-based source line. The
   * gutter draws one as a badge beside the line number, so a number printed on
   * the canvas (`note on 3` refers to the same one) can be found in the source
   * at a glance. Absent for a language that numbers nothing.
   */
  lineBadges?: ReadonlyMap<number, number>;
  /**
   * Every name in `value` the shell could locate, with its exact span — a
   * participant in a sequence diagram, an event/broker/channel/service in an
   * event flow. The editor bolds them in the highlight layer, and uses a
   * declaration's span to rename its usages live while its identifier is
   * retyped. The shell computes these from the parse; the editor never reads the
   * AST itself.
   */
  mentions?: readonly SourceMention[];
}

export default function Editor({
  value,
  onChange,
  diagnostics = [],
  reveal = null,
  complete,
  describe,
  onCaretChange,
  snippets = SEQUENCE_SNIPPETS,
  lineBadges,
  mentions,
}: EditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  // True while a drag is hovering the textarea, so it can show a drop hint.
  const [isDropTarget, setIsDropTarget] = useState(false);
  // Caret to restore after a snippet insertion re-renders the controlled value.
  const pendingCaret = useRef<number | null>(null);

  // Selecting a requested range is shared with the markdown editor.
  useEditorReveal(textareaRef, reveal, value);

  const lineCount = useMemo(() => value.split("\n").length, [value]);
  // The highlight layer's markup: the same text, with the names marked.
  const segments = useMemo(
    () => highlightSegments(value, mentions ?? NO_MENTIONS),
    [value, mentions],
  );
  // A diagram that numbers its messages reserves a badge column; a document
  // that numbers nothing keeps the plain, narrower gutter.
  const showSteps = (lineBadges?.size ?? 0) > 0;

  // --- Semantic completion and hover -------------------------------------
  // Both are props rather than state because the *facts* come from the project
  // index, which only the shell has. The editor owns the popup, the caret, and
  // the pointer; it never decides what a name means.
  const [completions, setCompletions] = useState<CompletionItem[]>([]);
  // The highlighted suggestion, or `null` while the popup is open but nothing
  // has been chosen yet. Enter and the arrow keys must not act on the popup
  // until the user has actually reached into it.
  const [completionIndex, setCompletionIndex] = useState<number | null>(null);
  // The key the popup consumed on keydown, so its matching keyup does not
  // rebuild the list and wipe out the choice the arrow key just made.
  const handledKey = useRef<string | null>(null);
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
    const items = complete({ source: value, offset });
    // A statement-start popup with nothing typed is a wall of keywords that
    // would otherwise swallow Enter (so no blank line is possible) and the
    // arrow keys. Keep the popup for a word being typed, or for a list that
    // names things (participants, events) rather than DSL words.
    const typed = items.some((item) => item.replaceEnd > item.replaceStart);
    const allKeywords = items.every((item) => item.kind === "keyword");
    const worthShowing = items.length > 0 && (typed || !allKeywords);
    setCompletions(worthShowing ? items : []);
    setCompletionIndex(null);
  };

  /** Insert a completion, replacing the word the user was typing. */
  const acceptCompletion = (item: CompletionItem) => {
    const textarea = textareaRef.current;
    const text = item.insertText ?? item.label;
    pendingCaret.current = item.replaceStart + text.length;
    setCompletions([]);
    setCompletionIndex(null);
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
        handledKey.current = event.key;
        setCompletionIndex((index) =>
          index === null ? 0 : (index + 1) % completions.length,
        );
        break;
      case "ArrowUp":
        event.preventDefault();
        handledKey.current = event.key;
        setCompletionIndex((index) =>
          index === null
            ? completions.length - 1
            : (index - 1 + completions.length) % completions.length,
        );
        break;
      case "Tab": {
        // Tab is the accept key; it never moves focus while the popup is open.
        const chosen = completions[completionIndex ?? 0];
        if (!chosen) return;
        event.preventDefault();
        handledKey.current = event.key;
        acceptCompletion(chosen);
        break;
      }
      case "Enter": {
        // Enter accepts only once a suggestion has been reached with the arrow
        // keys. Otherwise it inserts a newline, so a blank line is always
        // possible and the top suggestion is never inserted by accident.
        if (completionIndex === null) return;
        const chosen = completions[completionIndex];
        if (!chosen) return;
        event.preventDefault();
        handledKey.current = event.key;
        acceptCompletion(chosen);
        break;
      }
      case "Escape":
        event.preventDefault();
        handledKey.current = event.key;
        setCompletions([]);
        setCompletionIndex(null);
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

  /** Keep the gutter and highlight layer aligned with the textarea's scrolling. */
  const syncScroll = (element: HTMLTextAreaElement) => {
    if (gutterRef.current) {
      gutterRef.current.scrollTop = element.scrollTop;
    }
    if (highlightRef.current) {
      highlightRef.current.scrollTop = element.scrollTop;
      highlightRef.current.scrollLeft = element.scrollLeft;
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
          {Array.from({ length: lineCount }, (_, index) => {
            const step = lineBadges?.get(index);
            return (
              <span
                key={index}
                className={`editor__line-number${
                  showSteps ? " editor__line-number--steps" : ""
                }`}
              >
                {step === undefined ? null : (
                  <span
                    className="editor__step"
                    data-testid="editor-step"
                    data-step={step}
                  >
                    {step}
                  </span>
                )}
                <span className="editor__line-no">{index + 1}</span>
              </span>
            );
          })}
        </div>
        <div className="editor__input">
          <pre
            ref={highlightRef}
            className="editor__highlight"
            data-testid="editor-highlight"
            aria-hidden="true"
          >
            {segments.map((segment, index) =>
              segment.highlighted ? (
                <strong key={index}>{segment.text}</strong>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )}
          </pre>
          <textarea
            ref={textareaRef}
            id="dsl-input"
            className={`editor__textarea${
              isDropTarget ? " editor__textarea--drop" : ""
            }`}
            data-testid="dsl-textarea"
            aria-label="Sequence DSL"
            spellCheck={false}
            wrap="off"
            value={value}
            onChange={(event) => {
              const next = event.target.value;
              // Retyping a lifeline's name rewrites its usages, so the diagram
              // never collapses into "unknown participant" mid-edit.
              const rename = applyLiveRename({
                previous: value,
                next,
                caret: event.target.selectionStart ?? next.length,
                mentions: mentions ?? NO_MENTIONS,
              });
              if (rename.renamed) pendingCaret.current = rename.caret;
              onChange(rename.source);
              refreshCompletions(event.currentTarget);
            }}
            onKeyDown={onEditorKeyDown}
            onKeyUp={(event) => {
              // A key the popup consumed must not rebuild the list underneath it,
              // or the choice an arrow key just made would be reset.
              if (handledKey.current === event.key) {
                handledKey.current = null;
                return;
              }
              refreshCompletions(event.currentTarget);
            }}
            onClick={(event) => refreshCompletions(event.currentTarget)}
            onBlur={() => {
              setCompletions([]);
              setCompletionIndex(null);
            }}
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
              {snippets.map((snippet) => (
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
