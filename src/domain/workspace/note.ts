/**
 * Defaults shared by every repository implementation when creating a note.
 *
 * Keeping these here (rather than in one implementation) is what makes a note
 * created in-browser and a note created in a local folder look the same: the same
 * file name, the same seed heading, and the same "Untitled 2.md" collision
 * strategy.
 */

/** The file name a freshly created note starts with. */
export const EMPTY_NOTE_NAME = "Untitled.md";

/** The markdown a freshly created note starts with. */
export const EMPTY_NOTE_MARKDOWN = "# Untitled\n";

/**
 * Pick a note file name that is not already taken in a project.
 *
 * `Untitled.md` when free, else `Untitled 2.md`, `Untitled 3.md`, ... so creating
 * several notes in a row never clobbers an earlier one.
 */
export function uniqueNoteName(existing: string[]): string {
  if (!existing.includes(EMPTY_NOTE_NAME)) return EMPTY_NOTE_NAME;
  let index = 2;
  while (existing.includes(`Untitled ${index}.md`)) index += 1;
  return `Untitled ${index}.md`;
}

/**
 * Ensure a note file name carries the `.md` extension.
 *
 * Names are user input, so a note renamed to `design` becomes `design.md`; the
 * local-folder repository relies on the extension to tell notes from diagrams.
 */
export function ensureMarkdownExtension(name: string): string {
  return /\.md$/i.test(name) ? name : `${name}.md`;
}
