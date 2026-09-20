/**
 * Split DSL source into plain and participant-highlighted segments.
 *
 * A `<textarea>` cannot style part of its own text, so the editor draws a
 * highlight layer behind it and makes the textarea's glyphs transparent. That
 * layer needs the source cut into pieces that are either ordinary text or a
 * participant/actor name; this module does exactly that, and nothing else, so it
 * can be tested without a browser.
 *
 * Overlapping mentions are merged rather than duplicated, and a mention outside
 * the text (a stale range) is dropped instead of throwing.
 */
import type { ParticipantMention } from "../../domain/diagram/participant-mentions";
import { rangeToOffsets } from "../../language/source-position";

/** One run of source text, highlighted or not. */
export interface HighlightSegment {
  text: string;
  participant: boolean;
}

/** Cut `source` into segments, marking every participant mention's span. */
export function participantSegments(
  source: string,
  mentions: readonly ParticipantMention[],
): HighlightSegment[] {
  if (source === "") return [];

  const spans = mentions
    .map((mention) => rangeToOffsets(source, mention.range))
    .filter(
      ({ start, end }) => start >= 0 && end > start && end <= source.length,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const segments: HighlightSegment[] = [];
  const push = (text: string, participant: boolean): void => {
    if (text === "") return;
    const last = segments[segments.length - 1];
    // Merge abutting runs of the same kind, so a name split by an overlapping
    // mention is still one element.
    if (last && last.participant === participant) last.text += text;
    else segments.push({ text, participant });
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
