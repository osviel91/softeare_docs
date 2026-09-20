/**
 * Defaults shared by every repository implementation when creating a diagram.
 *
 * Mirrors `note.ts`: the same starting file name and the same "Untitled 2"
 * collision strategy, so a diagram created in-browser and one created in a
 * local folder look the same — and creating several in a row never clobbers an
 * earlier one.
 */

/** The file name a freshly created diagram starts with. */
export const EMPTY_DIAGRAM_NAME = "Untitled";

/**
 * Pick a diagram file name that is not already taken in a project.
 *
 * `Untitled` when free, else `Untitled 2`, `Untitled 3`, ...
 */
export function uniqueDiagramName(existing: string[]): string {
  if (!existing.includes(EMPTY_DIAGRAM_NAME)) return EMPTY_DIAGRAM_NAME;
  let index = 2;
  while (existing.includes(`Untitled ${index}`)) index += 1;
  return `Untitled ${index}`;
}
