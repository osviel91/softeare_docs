/**
 * Naming rules for duplicating a file within a project.
 *
 * A duplicate keeps its original's content but must never collide with a
 * sibling, so it gets a free name derived from the original: `flow copy`, then
 * `flow copy 2`, and so on, with any extension preserved (`flow.seq` →
 * `flow copy.seq`, `readme.md` → `readme copy.md`). Keeping the rules here —
 * rather than in one repository — is what makes a duplicate created in-browser
 * and one created in a local folder look the same.
 */

/**
 * Split `name.ext` into its base and extension. A leading dot is part of the
 * name (a dotfile), not an extension, so `.env` has no extension to preserve.
 */
function splitExtension(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, extension: "" };
  return { base: name.slice(0, dot), extension: name.slice(dot) };
}

/** The first-choice copy name: `flow.seq` becomes `flow copy.seq`. */
export function copyFileName(name: string): string {
  const { base, extension } = splitExtension(name);
  return `${base} copy${extension}`;
}

/**
 * Pick a copy name that is free among `existing`: `flow copy.seq` when
 * available, else `flow copy 2.seq`, `flow copy 3.seq`, ... so duplicating a
 * file repeatedly never overwrites an earlier copy.
 */
export function uniqueCopyName(
  name: string,
  existing: Iterable<string>,
): string {
  const taken = new Set(existing);
  const { base, extension } = splitExtension(name);
  const first = `${base} copy${extension}`;
  if (!taken.has(first)) return first;
  let index = 2;
  while (taken.has(`${base} copy ${index}${extension}`)) index += 1;
  return `${base} copy ${index}${extension}`;
}
