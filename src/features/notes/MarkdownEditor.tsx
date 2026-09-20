/**
 * Markdown document editor.
 *
 * A sibling of the DSL {@link ../../features/editor/Editor}, deliberately
 * simpler: markdown documents have no diagnostics, so this is a textarea with a
 * line-number gutter and a line count. It reuses the editor's CSS classes so both
 * surfaces look and behave the same, and it owns no state — the shell holds the
 * buffer and persists changes. Revealing a requested source range is shared with
 * the DSL editor through {@link useEditorReveal}.
 */
import { useMemo, useRef } from "react";
import type { EditorReveal } from "../editor/reveal";
import { useEditorReveal } from "../editor/use-reveal";

export interface MarkdownEditorProps {
  /** The current markdown. */
  value: string;
  /** Called with the new markdown whenever the user edits. */
  onChange: (value: string) => void;
  /** Accessible label for the textarea. */
  ariaLabel?: string;
  /** A source range to select and scroll to (used by project search). */
  reveal?: EditorReveal | null;
}

export default function MarkdownEditor({
  value,
  onChange,
  ariaLabel = "Markdown document",
  reveal = null,
}: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const lineCount = useMemo(() => value.split("\n").length, [value]);

  useEditorReveal(textareaRef, reveal, value);

  return (
    <div className="editor editor--markdown" data-testid="markdown-editor">
      <div className="editor__code">
        <div
          ref={gutterRef}
          className="editor__gutter"
          data-testid="markdown-gutter"
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
          id="markdown-input"
          className="editor__textarea"
          data-testid="markdown-textarea"
          aria-label={ariaLabel}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => {
            if (gutterRef.current) {
              gutterRef.current.scrollTop = event.currentTarget.scrollTop;
            }
          }}
          placeholder="# Overview

Describe the flow, then link a diagram with [[Diagram Name]]."
        />
      </div>

      <div className="editor__footer">
        <span className="editor__markdown-hint" data-testid="markdown-hint">
          Markdown · link a document with [[Name]]
        </span>
        <span className="editor__count" data-testid="markdown-line-count">
          {lineCount} line{lineCount === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}
