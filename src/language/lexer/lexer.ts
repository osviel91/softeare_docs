/**
 * Lexer for the Sequence Diagram DSL.
 *
 * The lexer turns raw source text into a flat list of tokens with precise
 * start/end positions. It is deliberately simple: it recognizes keywords,
 * identifiers, every message arrow form, the punctuation used by declarations
 * and fragments, quoted labels, and comments. Line/column tracking is handled up
 * front by splitting the source into lines, so every token knows where it lives.
 *
 * The lexer does not validate grammar; it only groups characters into tokens.
 * That separation lets the parser own structure and the diagnostics layer own
 * meaning. Arrows are emitted as one {@link TokenType.Arrow} token carrying the
 * matched spelling; mapping a spelling onto line/arrow style is the parser's
 * job, which keeps the arrow table in exactly one place (see ADR-013).
 */
import type { Column, Line, SourcePosition } from "../../domain/diagram/ast";

/** The kinds of tokens the lexer can emit. */
export enum TokenType {
  /** `title` keyword. */
  Title = "title",
  /** `participant` keyword. */
  Participant = "participant",
  /** `actor` keyword. */
  Actor = "actor",
  /** `alias` keyword. */
  Alias = "alias",
  /** `note` keyword. */
  Note = "note",
  /** `activate` keyword. */
  Activate = "activate",
  /** `deactivate` keyword. */
  Deactivate = "deactivate",
  /** `loop` keyword. */
  Loop = "loop",
  /** `alt` keyword. */
  Alt = "alt",
  /** `else` keyword. */
  Else = "else",
  /** `opt` keyword. */
  Opt = "opt",
  /** `par` keyword. */
  Par = "par",
  /** `and` keyword. */
  And = "and",
  /** `critical` keyword. */
  Critical = "critical",
  /** `option` keyword. */
  Option = "option",
  /** `break` keyword. */
  Break = "break",
  /** `end` keyword, closing a fragment or a multiline note. */
  End = "end",
  /** `semantic` metadata attached to the preceding message. */
  Semantic = "semantic",
  /** An unquoted identifier, e.g. `User` or `API`. */
  Identifier = "identifier",
  /**
   * A run of digits, e.g. the `3` in `note on 3 : text`. Numbers are their own
   * token so a message-step reference is unambiguous.
   */
  Number = "number",
  /** A double-quoted string literal, e.g. `"Authentication API"`. */
  StringLiteral = "string",
  /**
   * Any message arrow: `->`, `-->`, `->>`, `-->>`, `-x`, `--x`, `-)`, `--)`,
   * `<<->>`, `<<-->>`. The raw spelling is in the token's value.
   */
  Arrow = "arrow",
  /** `:` separating a message receiver from its label, or a note from its text. */
  Colon = "colon",
  /** `,` separating participants in a spanning `note over A,B`. */
  Comma = "comma",
  /** `=` binding an alias shorthand to a participant. */
  Equals = "equals",
  /** `+` opening an inline activation on a message. */
  Plus = "plus",
  /** `-` closing an inline activation on a message. */
  Minus = "minus",
  /** Any other run of characters that did not match a rule. */
  Unknown = "unknown",
  /** End of the current line; value carries the raw line text. */
  Eol = "eol",
}

/** A single lexical token with its source position. */
export interface Token {
  type: TokenType;
  /** The raw text this token matched. */
  value: string;
  start: SourcePosition;
  end: SourcePosition;
}

/** The result of lexing a document. */
export interface LexResult {
  tokens: Token[];
  /** Lexing never fails outright; problems surface as `Unknown` tokens. */
  diagnostics: { message: string; line: Line; column: Column }[];
}

/**
 * Every arrow spelling, longest first so `-->>` is never read as `-->` and
 * `<<-->>` is never read as `<<->>`. The parser maps each spelling onto the
 * `lineStyle` × `arrowStyle` model.
 */
const ARROW_FORMS = [
  "<<-->>",
  "<<->>",
  "-->>",
  "-->",
  "--x",
  "--)",
  "->>",
  "->",
  "-x",
  "-)",
] as const;

/** Split source into lines, always preserving a trailing empty line marker. */
function splitLines(source: string): string[] {
  const normalized = source.replace(/\r\n?/g, "\n");
  // Ensure a final newline so a last line without a terminator is still emitted.
  const withTrailingNewline = normalized.endsWith("\n")
    ? normalized
    : normalized + "\n";
  return withTrailingNewline.split("\n").slice(0, -1);
}

/**
 * Lex a single line into tokens. `lineIndex` is the zero-based line number.
 * A trailing `Eol` token marks the end of the line for the parser and carries
 * the line's raw text, so labels and multiline notes can preserve punctuation.
 */
function lexLine(
  line: string,
  lineIndex: Line,
  diagnostics: LexResult["diagnostics"],
): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = line.length;
  // Where the meaningful part of the line ends. A `//` comment truncates it, so
  // the parser's raw-line reader never picks comment text up as a label.
  let lineEnd = n;

  while (i < n) {
    const ch = line[i];

    // Whitespace separates tokens.
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }

    // Line comments: `//` ... to end of line.
    if (ch === "/" && line[i + 1] === "/") {
      lineEnd = i;
      break;
    }

    const start: SourcePosition = { line: lineIndex, column: i };

    // Double-quoted string literal.
    if (ch === '"') {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < n) {
        const c = line[j];
        if (c === '"') {
          closed = true;
          break;
        }
        value += c;
        j++;
      }
      if (!closed) {
        // Unterminated string: record a diagnostic and emit what we have.
        diagnostics.push({
          message: "Unterminated string literal",
          line: lineIndex,
          column: start.column,
        });
        tokens.push({
          type: TokenType.StringLiteral,
          value,
          start,
          end: { line: lineIndex, column: j },
        });
        i = j;
        continue;
      }
      tokens.push({
        type: TokenType.StringLiteral,
        value,
        start,
        end: { line: lineIndex, column: j + 1 },
      });
      i = j + 1;
      continue;
    }

    // Arrows, longest spelling first.
    const arrow = ARROW_FORMS.find((form) => line.startsWith(form, i));
    if (arrow) {
      tokens.push({
        type: TokenType.Arrow,
        value: arrow,
        start,
        end: { line: lineIndex, column: i + arrow.length },
      });
      i += arrow.length;
      continue;
    }

    // Single-character punctuation.
    if (ch === ":") {
      tokens.push({
        type: TokenType.Colon,
        value: ":",
        start,
        end: { line: lineIndex, column: i + 1 },
      });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({
        type: TokenType.Comma,
        value: ",",
        start,
        end: { line: lineIndex, column: i + 1 },
      });
      i += 1;
      continue;
    }
    if (ch === "=") {
      tokens.push({
        type: TokenType.Equals,
        value: "=",
        start,
        end: { line: lineIndex, column: i + 1 },
      });
      i += 1;
      continue;
    }
    // `+` / `-` are the inline activation suffixes; a `-` that begins an arrow
    // was already consumed above, and a `-` inside an identifier is matched by
    // the identifier rule because identifiers never start with one.
    if (ch === "+") {
      tokens.push({
        type: TokenType.Plus,
        value: "+",
        start,
        end: { line: lineIndex, column: i + 1 },
      });
      i += 1;
      continue;
    }
    if (ch === "-") {
      tokens.push({
        type: TokenType.Minus,
        value: "-",
        start,
        end: { line: lineIndex, column: i + 1 },
      });
      i += 1;
      continue;
    }

    // Keep plain numbers numeric, but allow digit-leading stable ids such as
    // UUIDs to remain one identifier token for semantic message references.
    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < n && isIdentifierPart(line[j])) j++;
      const word = line.slice(i, j);
      if (/[A-Za-z_.-]/.test(word)) {
        tokens.push({
          type: TokenType.Identifier,
          value: word,
          start,
          end: { line: lineIndex, column: j },
        });
        i = j;
        continue;
      }
      tokens.push({
        type: TokenType.Number,
        value: word,
        start,
        end: { line: lineIndex, column: j },
      });
      i = j;
      continue;
    }

    // Identifier: letters, digits, underscore, dot, and hyphen (for ids like
    // `payment-service`). We stop at a character that cannot extend it.
    if (isIdentifierStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentifierPart(line[j])) {
        j++;
      }
      const word = line.slice(i, j);
      const type = classifyKeyword(word);
      tokens.push({
        type,
        value: word,
        start,
        end: { line: lineIndex, column: j },
      });
      i = j;
      continue;
    }

    // Anything else is an unknown token; the parser will decide if it matters.
    tokens.push({
      type: TokenType.Unknown,
      value: ch,
      start,
      end: { line: lineIndex, column: i + 1 },
    });
    i += 1;
  }

  tokens.push({
    type: TokenType.Eol,
    value: line,
    start: { line: lineIndex, column: lineEnd },
    end: { line: lineIndex, column: lineEnd },
  });
  return tokens;
}

/** Whether `ch` may begin an identifier. */
function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

/** Whether `ch` may extend an identifier. */
function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_.-]/.test(ch);
}

/** Map a word to its keyword token type, or leave it an identifier. */
function classifyKeyword(word: string): TokenType {
  switch (word) {
    case "title":
      return TokenType.Title;
    case "participant":
      return TokenType.Participant;
    case "actor":
      return TokenType.Actor;
    case "alias":
      return TokenType.Alias;
    case "note":
      return TokenType.Note;
    case "activate":
      return TokenType.Activate;
    case "deactivate":
      return TokenType.Deactivate;
    case "loop":
      return TokenType.Loop;
    case "alt":
      return TokenType.Alt;
    case "else":
      return TokenType.Else;
    case "opt":
      return TokenType.Opt;
    case "par":
      return TokenType.Par;
    case "and":
      return TokenType.And;
    case "critical":
      return TokenType.Critical;
    case "option":
      return TokenType.Option;
    case "break":
      return TokenType.Break;
    case "end":
      return TokenType.End;
    case "semantic":
      return TokenType.Semantic;
    default:
      return TokenType.Identifier;
  }
}

/** Lex the entire source document into a flat token stream. */
export function lex(source: string): LexResult {
  const lines = splitLines(source);
  const tokens: Token[] = [];
  const diagnostics: LexResult["diagnostics"] = [];

  lines.forEach((line, lineIndex) => {
    const lineTokens = lexLine(line, lineIndex, diagnostics);
    // Keep the Eol marker: it tells the parser where each line ends so it can
    // stop reading a title/label and skip malformed lines.
    tokens.push(...lineTokens);
  });

  return { tokens, diagnostics };
}
