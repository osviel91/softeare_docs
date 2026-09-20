/**
 * Diagram naming.
 *
 * A diagram's name is not a separate field the user has to keep in sync with the
 * code: it is the `title` construct inside the diagram's own DSL source (see the
 * Title entry in `src/features/docs`). This module is the single, pure function
 * every surface calls to turn source into that name, so the explorer, the tab
 * bar, and the preview can never disagree.
 *
 * The result is memoized per source string. Deriving a name reparses the whole
 * source, and the explorer renders a row per diagram on every keystroke, so
 * without a cache each edit would reparse the entire workspace. The cache is
 * bounded and keyed by content, which keeps the function referentially
 * transparent: the same source always yields the same name.
 */
import { parse } from "./parser/parser";

/** How many parsed sources to remember before evicting the oldest. */
const CACHE_LIMIT = 200;

/** Memoized `source -> title` map, insertion-ordered for cheap eviction. */
const titleCache = new Map<string, string | undefined>();

/** The title declared in `source`, trimmed, or `undefined` when there is none. */
export function diagramTitle(source: string): string | undefined {
  const cached = titleCache.get(source);
  if (cached !== undefined || titleCache.has(source)) return cached;

  const { ast } = parse(source);
  const value = ast?.title?.value.trim();
  const title = value ? value : undefined;

  titleCache.set(source, title);
  if (titleCache.size > CACHE_LIMIT) {
    const oldest = titleCache.keys().next().value;
    if (oldest !== undefined) titleCache.delete(oldest);
  }
  return title;
}

/**
 * The name to show for a diagram: the title in its source, falling back to the
 * stored file name when the source declares none (for example an empty or
 * not-yet-titled diagram).
 */
export function diagramDisplayName(name: string, source: string): string {
  return diagramTitle(source) ?? name;
}

/**
 * Return `source` with its diagram title set to `title`.
 *
 * The first existing `title` line is replaced in place, so setting a title does
 * not move the line or disturb the rest of the document; when the source has no
 * title yet, a `title` line is prepended followed by a blank line. An empty
 * `title` removes the title line entirely, which falls the display name back to
 * the file name.
 */
export function withDiagramTitle(source: string, title: string): string {
  const trimmed = title.trim();
  const lines = source.split("\n");
  const index = lines.findIndex((line) => /^\s*title\s/i.test(line));

  if (index !== -1) {
    if (trimmed === "") {
      // Drop the title line and a single following blank line, if any, so
      // removing a title does not leave a hole at the top.
      lines.splice(index, 1);
      if (lines[index] === "") lines.splice(index, 1);
      return lines.join("\n");
    }
    lines[index] = `title ${trimmed}`;
    return lines.join("\n");
  }

  if (trimmed === "") return source;
  return `title ${trimmed}\n\n${source}`;
}
