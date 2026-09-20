/**
 * The exact source spans of every name an event flow writes.
 *
 * The counterpart of `participant-mentions.ts` for `*.eventseq`: the editor bolds
 * these names and renames their usages when a declaration is retyped, and it must
 * agree with the parser about what a name is and where it sits.
 *
 * Names are located from the language's own lexer rather than by scanning text,
 * so a name is exactly a word token — `order.created` and `order-created` are one
 * token each, while punctuation and metadata keys are never mistaken for a name.
 * Only a statement's first line is searched: an event's metadata block may quote
 * its own name in a value, and that is documentation, not a reference.
 */
import type { EventFlow } from "./ast";
import type { SourceMention } from "../source-mention";
import { tokenizeEventFlow } from "../../language/eventflow/lexer";

/** Where an event-flow document writes a name. */
export type EventFlowMentionContext =
  "declaration" | "event" | "service" | "channel" | "broker";

/** One occurrence of a name, with the exact span it occupies. */
export interface EventFlowMention extends SourceMention {
  context: EventFlowMentionContext;
}

/**
 * Collect every mention in `flow`, addressed by the exact span in `source`.
 *
 * Declarations and usages are found on the line the statement starts on, and a
 * name repeated on that line yields one span per occurrence — so renaming a
 * channel updates `topic orders on Kafka` and every edge that names `orders`.
 */
export function collectEventFlowMentions(
  flow: EventFlow,
  source: string,
): EventFlowMention[] {
  const tokensByLine = new Map(
    tokenizeEventFlow(source).map((line) => [line.line, line.tokens] as const),
  );
  const mentions: EventFlowMention[] = [];
  const seen = new Set<string>();

  /** Add every word token on `line` whose text is exactly `name`. */
  const add = (
    line: number,
    name: string,
    context: EventFlowMentionContext,
  ): void => {
    if (name === "") return;
    for (const token of tokensByLine.get(line) ?? []) {
      if (token.type !== "word" || token.value !== name) continue;
      const key = `${line}:${token.range.start.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mentions.push({ name, range: token.range, context });
    }
  };

  for (const statement of flow.statements) {
    const line = statement.range.start.line;
    switch (statement.type) {
      case "event":
      case "broker":
      case "service":
        add(line, statement.name, "declaration");
        break;
      case "channel":
        add(line, statement.name, "declaration");
        if (statement.broker !== undefined) {
          add(line, statement.broker, "broker");
        }
        break;
      case "publication":
        add(line, statement.producer, "service");
        add(line, statement.event, "event");
        if (statement.channel !== undefined) {
          add(line, statement.channel, "channel");
        }
        break;
      case "subscription":
        add(line, statement.consumer, "service");
        add(line, statement.event, "event");
        if (statement.channel !== undefined) {
          add(line, statement.channel, "channel");
        }
        break;
    }
  }

  return mentions;
}
