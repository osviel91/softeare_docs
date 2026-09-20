/**
 * Reveal a source range in a `<textarea>`-backed editor.
 *
 * Both editors (the DSL editor and the markdown editor) are textareas, so the
 * "select the range and bring it into view" behavior lives here once.
 *
 * A reveal is not applied blindly. The shell requests one and loads the document
 * in the same update, but the editor's buffer can settle a commit later — the tab
 * hook adopts the new document in a layout effect — so the effect waits until the
 * buffer actually holds the requested text before it moves the caret. Without
 * that check the caret would be placed against the previous document and then
 * thrown to the end of the file when the real content arrived.
 *
 * jsdom returns no usable `lineHeight`, so the scroll math falls back to a
 * typical editor line height rather than scrolling to `NaN`.
 */
import { useEffect, useRef, type RefObject } from "react";
import type { EditorReveal } from "./reveal";

/** A line height to assume when the computed one is unusable (jsdom). */
const FALLBACK_LINE_HEIGHT = 18;

/** Keep this many lines of context above the revealed line. */
const CONTEXT_LINES = 3;

export function useEditorReveal(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  reveal: EditorReveal | null | undefined,
  value: string,
): void {
  // The token of the last reveal that was actually applied, so a settled buffer
  // re-runs the effect without the caret being re-selected on every keystroke.
  const appliedToken = useRef<number | null>(null);

  useEffect(() => {
    if (!reveal) return;
    if (appliedToken.current === reveal.token) return;

    const textarea = textareaRef.current;
    if (!textarea) return;
    // The buffer does not hold this range yet (the document is still loading, or
    // this editor is showing a different file). Leave the caret alone.
    if (value.slice(reveal.start, reveal.end) !== reveal.text) return;

    appliedToken.current = reveal.token;
    textarea.focus();
    textarea.setSelectionRange(reveal.start, reveal.end);

    const computed = Number.parseFloat(
      window.getComputedStyle(textarea).lineHeight,
    );
    const lineHeight = Number.isFinite(computed)
      ? computed
      : FALLBACK_LINE_HEIGHT;
    textarea.scrollTop = Math.max(
      0,
      (reveal.line - 1 - CONTEXT_LINES) * lineHeight,
    );
  }, [textareaRef, reveal, value]);
}
