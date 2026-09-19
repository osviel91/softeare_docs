/**
 * Lexer for the Sequence Diagram DSL.
 *
 * The lexer turns raw source text into a flat list of tokens with precise
 * start/end positions. It is deliberately simple: it recognizes keywords,
 * identifiers, the two arrow forms, the label colon, quoted labels, and
 * comments. Line/column tracking is handled up front by splitting the source
 * into lines, so every token knows where it lives.
 *
 * The lexer does not validate grammar; it only groups characters into tokens.
 * That separation lets the parser own structure and the diagnostics layer own
 * meaning.
 */
import type { Column, Line, SourcePosition } from "../../domain/diagram/ast";

/** The kinds of tokens the lexer can emit. */
export enum TokenType {
  /** `title` keyword. */
  Title = "title",
  /** `participant` keyword. */
  Participant = "participant",
  /** An unquoted identifier, e.g. `User` or `API`. */
  Identifier = "identifier",
  /** A double-quoted string literal, e.g. `"Authentication API"`. */
  StringLiteral = "string",
  /** `->` (synchronous arrow). */
  SyncArrow = "sync-arrow",
  /** `-->` (asynchronous / response arrow). */
  ResponseArrow = "response-arrow",
  /** `:` separating a message receiver from its label. */
  Colon = "colon",
  /** Any other run of characters that did not match a rule. */
  Unknown = "unknown",
  /** End of the current line; used as a line boundary marker. */
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
 * A trailing `Eol` token marks the end of the line for the parser.
 */
function lexLine(
  line: string,
  lineIndex: Line,
  diagnostics: LexResult["diagnostics"],
): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i];

    // Whitespace separates tokens.
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }

    // Line comments: `//` ... to end of line.
    if (ch === "/" && line[i + 1] === "/") {
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
          message: 'Unterminated string literal',
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

    // Two-character arrows first so `-->` is not read as `-` then `->`.
    if (ch === "-" && line[i + 1] === ">") {
      tokens.push({
        type: TokenType.SyncArrow,
        value: "->",
        start,
        end: { line: lineIndex, column: i + 2 },
      });
      i += 2;
      continue;
    }
    if (ch === "-" && line[i + 1] === "-" && line[i + 2] === ">") {
      tokens.push({
        type: TokenType.ResponseArrow,
        value: "-->",
        start,
        end: { line: lineIndex, column: i + 3 },
      });
      i += 3;
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

    // Identifier: letters, digits, underscore, dot, and hyphen (for ids like
    // `payment-service`). We stop at a character that cannot extend it.
    if (isIdentifierStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentifierPart(line[j])) {
        j++;
      }
      const word = line.slice(i, j);
      const type = classifyKeyword(word);
      tokens.push({ type, value: word, start, end: { line: lineIndex, column: j } });
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

  tokens.push({ type: TokenType.Eol, value: "", start: { line: lineIndex, column: n }, end: { line: lineIndex, column: n } });
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
  if (word === "title") return TokenType.Title;
  if (word === "participant") return TokenType.Participant;
  return TokenType.Identifier;
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
