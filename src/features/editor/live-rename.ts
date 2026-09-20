/**
 * Live rename: renaming a participant declaration rewrites its usages as you type.
 *
 * A diagram collapses the moment a `participant` line and its messages disagree,
 * so retyping a lifeline's name at the top would blank the preview until every
 * message was fixed by hand. This module propagates the edit instead: when the
 * change lands inside a declaration's identifier, every usage of the old name is
 * rewritten to the new one.
 *
 * It is deliberately conservative and span-based, never a text search:
 *
 * - only a declaration's own identifier triggers it;
 * - only usages the analyser identified, and only in this document, change;
 * - a rename that would merge two lifelines (the new name is already taken) is
 *   refused, so the user resolves the clash rather than losing a lifeline;
 * - an edit that runs through a usage leaves that usage alone rather than
 *   guessing.
 *
 * The caller keeps ownership of the buffer: this returns the new text and the
 * caret offset that goes with it, and applies nothing itself.
 */
import type { ParticipantMention } from "../../domain/diagram/participant-mentions";
import { rangeToOffsets } from "../../language/source-position";

export interface LiveRenameRequest {
  /** The text before this edit. */
  previous: string;
  /** The text the textarea holds after this edit. */
  next: string;
  /** The caret offset within `next`. */
  caret: number;
  /** Mentions located in `previous`, from the last parse. */
  mentions: readonly ParticipantMention[];
}

export interface LiveRenameResult {
  /** The text to store: `next`, with usages rewritten when it applies. */
  source: string;
  /** The caret offset within `source`. */
  caret: number;
  /** Whether any usage was rewritten. */
  renamed: boolean;
}

/** The first character of an identifier. */
const IDENTIFIER_START = /[A-Za-z_]/;
/** The characters an identifier may continue with. */
const IDENTIFIER_BODY = /[\w.-]/;

/** The longest identifier starting at `offset`, or `""` when none does. */
function identifierAt(text: string, offset: number): string {
  if (offset < 0 || offset >= text.length) return "";
  if (!IDENTIFIER_START.test(text[offset])) return "";
  let end = offset;
  while (end < text.length && IDENTIFIER_BODY.test(text[end])) end += 1;
  return text.slice(offset, end);
}

/**
 * The single contiguous region an edit replaced, in `previous` coordinates.
 *
 * Common-prefix/suffix diffing is enough because a textarea edit is one
 * replacement; it also gives the prefix offset, which is what says whether the
 * caret sits in a declaration's identifier.
 */
function changedRegion(
  previous: string,
  next: string,
): { prefix: number; endPrev: number } {
  const max = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < max && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { prefix, endPrev: previous.length - suffix };
}

/** Apply a live rename, or return the edit untouched when it does not apply. */
export function applyLiveRename(request: LiveRenameRequest): LiveRenameResult {
  const { previous, next, caret, mentions } = request;
  const untouched: LiveRenameResult = {
    source: next,
    caret,
    renamed: false,
  };
  if (previous === next || mentions.length === 0) return untouched;

  const { prefix, endPrev } = changedRegion(previous, next);

  const declarations = mentions
    .filter((mention) => mention.context === "declaration")
    .map((mention) => ({
      name: mention.name,
      offsets: rangeToOffsets(previous, mention.range),
    }));

  // The edit must land in a declaration's identifier — its start is at or after
  // the identifier's start and no further than its end, so typing at the end
  // counts while editing the next line does not. `endPrev <= end` rejects a
  // deletion that runs past the identifier (joining the following line into it),
  // which is not a rename.
  const edited = declarations.find(
    (declaration) =>
      prefix >= declaration.offsets.start &&
      prefix <= declaration.offsets.end &&
      endPrev <= declaration.offsets.end,
  );
  if (!edited) return untouched;

  const oldId = edited.name;
  const newId = identifierAt(next, edited.offsets.start);
  if (newId === "" || newId === oldId) return untouched;
  // Merging two lifelines is not a rename; leave the clash visible instead.
  if (declarations.some((declaration) => declaration.name === newId)) {
    return untouched;
  }

  const delta = next.length - previous.length;
  const replacements: Array<{ start: number; end: number }> = [];
  for (const mention of mentions) {
    if (mention.context === "declaration" || mention.name !== oldId) continue;
    const offsets = rangeToOffsets(previous, mention.range);
    if (offsets.end <= prefix) {
      replacements.push({ start: offsets.start, end: offsets.end });
    } else if (offsets.start >= endPrev) {
      replacements.push({
        start: offsets.start + delta,
        end: offsets.end + delta,
      });
    }
    // Otherwise the edit ran through this usage; leave it for the user.
  }
  if (replacements.length === 0) return untouched;

  // Replace from the end backwards, so an earlier span keeps its offsets, and
  // shift the caret by every replacement that sits before it.
  replacements.sort((a, b) => b.start - a.start);
  let source = next;
  let shiftedCaret = caret;
  for (const replacement of replacements) {
    source = `${source.slice(0, replacement.start)}${newId}${source.slice(
      replacement.end,
    )}`;
    if (replacement.start < caret) {
      shiftedCaret += newId.length - oldId.length;
    }
  }
  return { source, caret: shiftedCaret, renamed: true };
}
