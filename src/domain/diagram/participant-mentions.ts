/**
 * The exact source spans of every participant mention in a diagram.
 *
 * The AST records which participant a statement *uses*, but a statement's range
 * covers the whole construct rather than the name inside it. Three features need
 * the token itself, and they must agree about where it is:
 *
 * - the editor's highlight layer, which bolds participant and actor names;
 * - live rename, which rewrites the usages of a declaration while it is typed;
 * - the project index, which records declaration and usage spans so that
 *   find-references and semantic rename can work.
 *
 * This module is that one definition. It locates a name as a whole word in the
 * part of a line that can hold an endpoint — everything before the first `:`,
 * which is where the DSL puts a label or a note body — so `Payment` never matches
 * inside `PaymentService` and prose in a label is never mistaken for an endpoint.
 */
import type { SequenceDiagram, SourceRange } from "./ast";
import { walkStatements } from "./ast";

/** Where a participant's name is written. */
export type ParticipantMentionContext =
  "declaration" | "message" | "activation" | "note" | "alias";

/** The mention contexts that are *usages* rather than the declaration itself. */
export type ParticipantUsageContext = Exclude<
  ParticipantMentionContext,
  "declaration"
>;

/** One occurrence of a participant's name, with the exact span it occupies. */
export interface ParticipantMention {
  name: string;
  range: SourceRange;
  context: ParticipantMentionContext;
}

/** Escape a string for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A whole-word matcher for `name`, so `Payment` never matches `PaymentService`. */
function wholeWordPattern(name: string, global: boolean): RegExp {
  return new RegExp(
    `(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`,
    global ? "g" : "",
  );
}

/** The part of a line that can hold an endpoint: everything before the first `:`. */
function endpointSegment(line: string): string {
  const colon = line.indexOf(":");
  return colon === -1 ? line : line.slice(0, colon);
}

/**
 * Collect every mention in `diagram`, addressed by the exact span in `source`.
 *
 * Declarations come first (one span each, the identifier token), then usages in
 * source order. A name written twice on one line — a self-message `A -> A` —
 * yields one span per occurrence, because a rename has to rewrite both.
 */
export function collectParticipantMentions(
  diagram: SequenceDiagram,
  source: string,
): ParticipantMention[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const mentions: ParticipantMention[] = [];
  const seen = new Set<string>();

  /** Add every whole-word occurrence of `name` in `line`'s endpoint segment. */
  const addUsages = (
    name: string,
    line: number,
    context: ParticipantUsageContext,
  ): void => {
    if (name === "") return;
    const text = lines[line];
    if (text === undefined) return;
    const segment = endpointSegment(text);
    const pattern = wholeWordPattern(name, true);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(segment)) !== null) {
      const key = `${line}:${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mentions.push({
        name,
        context,
        range: {
          start: { line, column: match.index },
          end: { line, column: match.index + name.length },
        },
      });
    }
  };

  // The declaration's own identifier: the first whole-word occurrence on its
  // line, which is the id right after `participant` / `actor`.
  for (const participant of diagram.participants) {
    if (participant.id === "") continue;
    const line = participant.range.start.line;
    const text = lines[line];
    if (text === undefined) continue;
    const match = wholeWordPattern(participant.id, false).exec(
      endpointSegment(text),
    );
    if (!match) continue;
    const key = `${line}:${match.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push({
      name: participant.id,
      context: "declaration",
      range: {
        start: { line, column: match.index },
        end: { line, column: match.index + participant.id.length },
      },
    });
  }

  for (const statement of walkStatements(diagram.statements)) {
    switch (statement.type) {
      case "message":
        addUsages(statement.from, statement.range.start.line, "message");
        addUsages(statement.to, statement.range.start.line, "message");
        break;
      case "activation":
        addUsages(
          statement.participant,
          statement.range.start.line,
          "activation",
        );
        break;
      default:
        // A fragment owns no participants of its own; its statements are walked
        // above.
        break;
    }
  }

  for (const note of diagram.notes) {
    for (const participant of note.participants) {
      addUsages(participant, note.range.start.line, "note");
    }
  }
  for (const alias of diagram.aliases) {
    addUsages(alias.target, alias.range.start.line, "alias");
  }

  return mentions;
}

/** Just the usage mentions, in source order. */
export function participantUsagesOf(
  diagram: SequenceDiagram,
  source: string,
): Array<ParticipantMention & { context: ParticipantUsageContext }> {
  return collectParticipantMentions(diagram, source).filter(
    (
      mention,
    ): mention is ParticipantMention & {
      context: ParticipantUsageContext;
    } => mention.context !== "declaration",
  );
}
