/**
 * Lexer for the event-flow DSL.
 *
 * The language is line-oriented: every statement lives on one line, so the
 * lexer's job is to split a document into lines and each line into a handful of
 * tokens carrying their own source positions. There is no expression grammar to
 * tokenize, which is why this is a few dozen lines rather than a state machine.
 *
 * A line whose first non-space character is `#` is a comment. Comments are only
 * recognised at the start of a line, so a `#` inside a metadata value (a schema
 * fragment URL, say) stays part of the value.
 */
import type { SourceRange } from "../../domain/eventflow/ast";

/** What a token is. Words carry identifiers and keywords; the rest are syntax. */
export type EventFlowTokenType = "word" | "colon" | "braceOpen" | "braceClose";

/** One token, with the span it occupies. */
export interface EventFlowToken {
  type: EventFlowTokenType;
  /** The token's text; for punctuation, the punctuation itself. */
  value: string;
  range: SourceRange;
}

/** One line of tokens, with the raw text for excerpts and diagnostics. */
export interface EventFlowLine {
  /** 0-based line number in the document. */
  line: number;
  /** The line as written, without its terminator. */
  text: string;
  tokens: EventFlowToken[];
}

/** Punctuation the lexer recognises, mapped to its token type. */
const PUNCTUATION: Record<string, EventFlowTokenType> = {
  ":": "colon",
  "{": "braceOpen",
  "}": "braceClose",
};

/** Whether a character separates tokens. */
function isSpace(character: string): boolean {
  return character === " " || character === "\t";
}

/**
 * Tokenize one line of source.
 *
 * @param text - The line's text, without its terminator.
 * @param line - Its 0-based line number, so tokens carry absolute positions.
 */
export function tokenizeEventFlowLine(
  text: string,
  line: number,
): EventFlowToken[] {
  const tokens: EventFlowToken[] = [];
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    if (isSpace(character)) {
      index += 1;
      continue;
    }

    const punctuation = PUNCTUATION[character];
    if (punctuation) {
      tokens.push({
        type: punctuation,
        value: character,
        range: {
          start: { line, column: index },
          end: { line, column: index + 1 },
        },
      });
      index += 1;
      continue;
    }

    const start = index;
    while (
      index < text.length &&
      !isSpace(text[index]) &&
      PUNCTUATION[text[index]] === undefined
    ) {
      index += 1;
    }
    tokens.push({
      type: "word",
      value: text.slice(start, index),
      range: {
        start: { line, column: start },
        end: { line, column: index },
      },
    });
  }

  return tokens;
}

/** Tokenize a whole document into non-empty, non-comment lines. */
export function tokenizeEventFlow(source: string): EventFlowLine[] {
  return source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((text, line) => ({ text, line }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      return trimmed !== "" && !trimmed.startsWith("#");
    })
    .map(({ text, line }) => ({
      line,
      text,
      tokens: tokenizeEventFlowLine(text, line),
    }));
}
