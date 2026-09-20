/**
 * Split DSL source into plain and name-highlighted segments.
 *
 * A `<textarea>` cannot style part of its own text, so the editor draws a
 * highlight layer behind it and makes the textarea's glyphs transparent. That
 * layer needs the source cut into pieces that are either ordinary text or a name
 * worth bolding — a participant in a sequence diagram, an event, broker, channel
 * or service in an event flow. This module does exactly that, and nothing else,
 * so it can be tested without a browser.
 *
 * Overlapping mentions are merged rather than duplicated, and a mention outside
 * the text (a stale range) is dropped instead of throwing.
 */
import type { SourceMention } from "../../domain/source-mention";
import { rangeToOffsets } from "../../language/source-position";

/** One run of source text, highlighted or not. */
export interface HighlightSegment {
  text: string;
  highlighted: boolean;
}

/** Cut `source` into segments, marking every mention's span. */
export function highlightSegments(
  source: string,
  mentions: readonly SourceMention[],
): HighlightSegment[] {
  if (source === "") return [];

  const spans = mentions
    .map((mention) => rangeToOffsets(source, mention.range))
    .filter(
      ({ start, end }) => start >= 0 && end > start && end <= source.length,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const segments: HighlightSegment[] = [];
  const push = (text: string, highlighted: boolean): void => {
    if (text === "") return;
    const last = segments[segments.length - 1];
    // Merge abutting runs of the same kind, so a name split by an overlapping
    // mention is still one element.
    if (last && last.highlighted === highlighted) last.text += text;
    else segments.push({ text, highlighted });
  };

  let cursor = 0;
  for (const span of spans) {
    if (span.end <= cursor) continue; // fully covered by an earlier mention
    const start = Math.max(span.start, cursor);
    if (start > cursor) push(source.slice(cursor, start), false);
    push(source.slice(start, span.end), true);
    cursor = span.end;
  }
  if (cursor < source.length) push(source.slice(cursor), false);
  return segments;
}
