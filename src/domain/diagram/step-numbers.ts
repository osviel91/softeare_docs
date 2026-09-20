/**
 * The numbers the diagram prints in circles, keyed by the source line.
 *
 * Every message — call and response alike — is numbered in source order, which
 * is what `note on 3` refers to and what the renderer draws as a badge next to
 * the arrow. The editor gutter shows the same number beside the statement that
 * produced it, so a reader can go from a circled number on the canvas to its
 * source line without counting arrows.
 *
 * The order is exactly the one the layout uses: a depth-first walk of the
 * statement tree, so a message written inside a fragment is numbered where it is
 * written. Both derive from source order, so they cannot disagree about which
 * message is number 3.
 */
import type { SequenceDiagram } from "./ast";
import { walkStatements } from "./ast";

/** 0-based source line to 1-based diagram step number. */
export type StepNumbersByLine = ReadonlyMap<number, number>;

/**
 * The step number of every message in `diagram`, keyed by its 0-based line.
 *
 * Returns an empty map for a missing diagram. A line can hold at most one
 * message in a line-oriented DSL, and the first one wins defensively so a
 * surprising parse can never make a later message overwrite an earlier badge.
 */
export function messageStepNumbers(
  diagram: SequenceDiagram | null,
): StepNumbersByLine {
  const byLine = new Map<number, number>();
  if (!diagram) return byLine;

  let step = 0;
  for (const statement of walkStatements(diagram.statements)) {
    if (statement.type !== "message") continue;
    step += 1;
    const line = statement.range.start.line;
    if (!byLine.has(line)) byLine.set(line, step);
  }
  return byLine;
}
