/**
 * Note naming and title editing.
 *
 * A note's display title is the first level-1 heading in its markdown, falling
 * back to the file name. Keeping this derivation in one pure module means the
 * explorer, the tab strip, and the note header can never disagree — the same
 * relationship {@link ../../language/diagram-title} provides for diagrams.
 */

/** The first level-1 ATX heading in `markdown`, trimmed, or `undefined`. */
export function noteTitle(markdown: string): string | undefined {
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) {
      const title = match[1].trim();
      if (title !== "") return title;
    }
  }
  return undefined;
}

/** Strip a trailing `.md` extension from a file name. */
function withoutExtension(name: string): string {
  return name.replace(/\.md$/i, "");
}

/**
 * The name to show for a note: its first heading, falling back to the file name
 * without the `.md` extension, then to "Untitled".
 */
export function noteDisplayName(name: string, markdown: string): string {
  const title = noteTitle(markdown);
  if (title) return title;
  const base = withoutExtension(name).trim();
  return base === "" ? "Untitled" : base;
}

/**
 * Return `markdown` with its level-1 title set to `title`.
 *
 * The first existing `# ` heading is replaced in place, so the rest of the
 * document keeps its shape; when the note has no heading, one is prepended (with
 * a blank line) so the note immediately gains a name.
 */
export function withNoteTitle(markdown: string, title: string): string {
  const trimmed = title.trim();
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const index = lines.findIndex((line) => /^#\s+/.test(line));

  if (index !== -1) {
    if (trimmed === "") {
      // Drop the heading and a single following blank line, if any.
      lines.splice(index, 1);
      if (lines[index] === "") lines.splice(index, 1);
      return lines.join("\n");
    }
    lines[index] = `# ${trimmed}`;
    return lines.join("\n");
  }

  if (trimmed === "") return markdown;
  return `# ${trimmed}\n\n${markdown}`;
}

/** The heading text of a note as `{ level, text }` pairs, in source order. */
export function noteHeadings(
  markdown: string,
): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) headings.push({ level: match[1].length, text: match[2].trim() });
  }
  return headings;
}
