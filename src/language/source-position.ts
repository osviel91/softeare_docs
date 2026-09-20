/**
 * Conversions between character offsets and AST source positions.
 *
 * The editor works in character offsets (`selectionStart` / `selectionEnd`),
 * while every AST node is annotated with a zero-based line/column
 * {@link SourcePosition}. The two coordinate systems meet here — and only here —
 * so neither the parser nor the UI has to know about the other.
 *
 * Every function clamps out-of-range input instead of throwing. The editor asks
 * these questions about text that is mid-edit, where a stale offset, a column
 * past the end of a line, or a line past the end of the document is normal
 * rather than a bug.
 *
 * Line breaks follow the lexer's normalization: `\r\n` and a lone `\r` each
 * count as a single break, so positions computed here line up with the AST even
 * for documents with Windows or classic-Mac line endings.
 */
import type { SourcePosition, SourceRange } from "../domain/diagram/ast";

/** Clamp a number into the inclusive range `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** Order two positions: negative when `a` precedes `b`, zero when equal. */
function comparePositions(a: SourcePosition, b: SourcePosition): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.column - b.column;
}

/**
 * The line/column position of a character offset.
 *
 * The offset is clamped to `[0, text.length]`, so an offset from a stale
 * selection resolves to the document start or end instead of throwing.
 */
export function offsetToPosition(text: string, offset: number): SourcePosition {
  const target = clamp(offset, 0, text.length);
  let line = 0;
  let column = 0;
  let index = 0;

  while (index < target) {
    const char = text[index];
    if (char === "\r") {
      // A CRLF pair is one break. Consume both characters when the offset lies
      // beyond the pair; when it falls between them, only the CR is consumed.
      index += text[index + 1] === "\n" && index + 1 < target ? 2 : 1;
      line += 1;
      column = 0;
    } else if (char === "\n") {
      index += 1;
      line += 1;
      column = 0;
    } else {
      index += 1;
      column += 1;
    }
  }

  return { line, column };
}

/**
 * The character offset of a line/column position.
 *
 * Negative coordinates clamp to the start of the document, a column past the
 * end of its line clamps to that line's end, and a line past the last one
 * clamps to the end of the document.
 */
export function positionToOffset(
  text: string,
  position: SourcePosition,
): number {
  const targetLine = clamp(
    Math.floor(position.line),
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const targetColumn = clamp(
    Math.floor(position.column),
    0,
    Number.MAX_SAFE_INTEGER,
  );

  let line = 0;
  let lineStart = 0;
  let index = 0;
  while (index < text.length && line < targetLine) {
    const char = text[index];
    if (char === "\r") {
      index += text[index + 1] === "\n" ? 2 : 1;
      line += 1;
      lineStart = index;
    } else if (char === "\n") {
      index += 1;
      line += 1;
      lineStart = index;
    } else {
      index += 1;
    }
  }

  // Past the final line: clamp to the end of the document.
  if (line < targetLine) return text.length;

  let lineEnd = lineStart;
  while (
    lineEnd < text.length &&
    text[lineEnd] !== "\n" &&
    text[lineEnd] !== "\r"
  ) {
    lineEnd += 1;
  }

  return Math.min(lineStart + targetColumn, lineEnd);
}

/**
 * The character offsets of a range's two endpoints, each clamped independently.
 *
 * A range whose end precedes its start (only possible for a hand-built AST)
 * keeps that order, so callers can detect it rather than silently receive a
 * swapped pair.
 */
export function rangeToOffsets(
  text: string,
  range: SourceRange,
): { start: number; end: number } {
  return {
    start: positionToOffset(text, range.start),
    end: positionToOffset(text, range.end),
  };
}

/**
 * Whether a range contains a position.
 *
 * The range is treated as half-open: `start` is included, `end` is excluded.
 * A zero-width range additionally contains its own start, so a degenerate node
 * (an insertion point or an empty label) is still addressable.
 */
export function rangeContainsPosition(
  range: SourceRange,
  position: SourcePosition,
): boolean {
  const { start, end } = range;
  if (comparePositions(position, start) < 0) return false;
  if (comparePositions(position, end) < 0) return true;
  // A zero-width range would otherwise exclude the only point it covers.
  return (
    comparePositions(start, end) === 0 &&
    comparePositions(position, start) === 0
  );
}
