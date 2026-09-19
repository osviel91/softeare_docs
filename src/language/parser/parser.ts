/**
 * Recursive-descent parser for the Sequence Diagram DSL.
 *
 * The parser consumes the flat token stream from {@link lex} and produces a
 * best-effort {@link SequenceDiagram} plus diagnostics. It never throws for bad
 * input: on a syntax error it records a diagnostic, skips to the end of the
 * offending line, and keeps going so the editor stays usable.
 *
 * Grammar (Phase 1):
 *
 *   document     := title? statement*
 *   statement    := participant | message
 *   participant  := "participant" ws+ id (ws* quotedLabel)?
 *   message      := id arrow id (":" labelText)?
 *   title        := "title" ws* lineText
 *
 * Structural rule: participants must be declared before any message. This
 * mirrors how sequence diagrams are read top-to-bottom and gives the parser a
 * clear phase boundary.
 */
import type {
  MessageKind,
  ParticipantId,
  SourcePosition,
  SourceRange,
} from "../../domain/diagram/ast";
import type { SequenceDiagram } from "../../domain/diagram/ast";
import type { Diagnostic, ParseResult } from "../diagnostics/diagnostics";
import { DiagnosticCode, errorDiagnostic } from "../diagnostics/diagnostics";
import { lex, type Token, TokenType } from "../lexer/lexer";

/** A parser that fails closed: it records diagnostics instead of throwing. */
class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  private diagnostics: Diagnostic[] = [];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  /** Parse the whole document into a best-effort AST and diagnostics. */
  parse(): { ast: SequenceDiagram; diagnostics: Diagnostic[] } {
    const ast: SequenceDiagram = { participants: [], statements: [] };
    this.diagnostics = [];

    // Optional title on the first line.
    if (this.peek()?.type === TokenType.Title) {
      const title = this.parseTitle();
      if (title) ast.title = title;
    }

    let sawMessage = false;

    while (!this.atEnd()) {
      const token = this.peek()!;
      if (token.type === TokenType.Eol) {
        // Blank line; skip silently.
        this.advance();
        continue;
      }

      if (token.type === TokenType.Participant) {
        if (sawMessage) {
          this.errorHere(
            "Participant must be declared before any message",
            DiagnosticCode.StatementBeforeParticipant,
          );
          this.skipToEol();
        } else {
          const participant = this.parseParticipant();
          if (participant) ast.participants.push(participant);
          else this.skipToEol();
        }
      } else if (token.type === TokenType.Identifier) {
        // A message line.
        sawMessage = true;
        const message = this.parseMessage();
        if (message) ast.statements.push(message);
        else this.skipToEol();
      } else {
        this.errorHere(
          `Unexpected token "${token.value}"`,
          DiagnosticCode.UnsupportedSyntax,
        );
        this.skipToEol();
      }
    }

    return { ast, diagnostics: this.diagnostics };
  }

  /** Parse a title line: `title <text>` where text may be quoted. */
  private parseTitle(): { value: string; range: SourceRange } | null {
    const start = this.expect().start;
    const value = this.readLineText();
    const end = this.previousEnd();
    return { value, range: span(start, end) };
  }

  /** Parse a participant declaration line. */
  private parseParticipant(): {
    type: "participant";
    id: ParticipantId;
    label: string;
    range: SourceRange;
  } | null {
    const start = this.expect().start;

    const idToken = this.peek();
    if (!idToken || idToken.type !== TokenType.Identifier) {
      this.errorHere(
        'Expected a participant name after "participant"',
        DiagnosticCode.MalformedMessage,
      );
      return null;
    }
    this.advance();

    const end = this.previousEnd();
    return { type: "participant", id: idToken.value, label: idToken.value, range: span(start, end) };
  }

  /** Parse a message line: `from arrow to (":" label)?`. */
  private parseMessage(): {
    type: "message";
    kind: MessageKind;
    from: ParticipantId;
    to: ParticipantId;
    label: string;
    range: SourceRange;
  } | null {
    const start = this.peek()!.start;

    const from = this.peek();
    if (!from || from.type !== TokenType.Identifier) {
      this.errorHere(
        "Expected a participant name at the start of a message",
        DiagnosticCode.MalformedMessage,
      );
      return null;
    }
    this.advance();

    const arrow = this.peek();
    if (!arrow) {
      this.errorHere("Expected an arrow (-> or -->) in the message", DiagnosticCode.MalformedMessage);
      return null;
    }
    if (arrow.type === TokenType.SyncArrow) this.advance();
    else if (arrow.type === TokenType.ResponseArrow) this.advance();
    else {
      this.errorHere("Expected an arrow (-> or -->) in the message", DiagnosticCode.MalformedMessage);
      return null;
    }

    const to = this.peek();
    if (!to || to.type !== TokenType.Identifier) {
      this.errorHere("Expected a receiver participant after the arrow", DiagnosticCode.MalformedMessage);
      return null;
    }
    this.advance();

    const kind: MessageKind = arrow.value === "->" ? "sync" : "response";

    let label = "";
    // Optional `: label`.
    if (this.peek()?.type === TokenType.Colon) {
      this.advance();
      label = this.readLineText();
    } else if (this.peek()?.type !== TokenType.Eol && !this.atEnd()) {
      // Trailing text without a colon is malformed.
      this.errorHere(
        "Expected ':' after message receiver",
        DiagnosticCode.MalformedMessage,
      );
    }

    const end = this.previousEnd();
    return { type: "message", kind, from: from.value, to: to.value, label, range: span(start, end) };
  }

  /** Read the remaining text of the current line as a label/title value. */
  private readLineText(): string {
    let text = "";
    while (!this.atEnd() && this.peek()!.type !== TokenType.Eol) {
      const token = this.advance();
      if (text !== "") text += " ";
      text += token.value;
    }
    return text.trim();
  }

  // --- Token cursor helpers -------------------------------------------------

  private atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const token = this.tokens[this.pos]!;
    this.pos++;
    return token;
  }

  private expect(): Token {
    return this.advance();
  }

  /** Record an error diagnostic at the current token's span. */
  private errorHere(message: string, code: DiagnosticCode): void {
    const token = this.peek()!;
    const diagnostic = errorDiagnostic(message, code, span(token.start, token.end));
    this.diagnostics.push(diagnostic);
  }

  /** Advance to the end of the current line after a failed statement. */
  private skipToEol(): void {
    while (!this.atEnd() && this.peek()!.type !== TokenType.Eol) {
      this.advance();
    }
    if (!this.atEnd()) this.advance();
  }

  /** End position of the most recently advanced token. */
  private previousEnd(): SourcePosition {
    return this.tokens[this.pos - 1]!.end;
  }
}

/** Parse source text into a best-effort AST and diagnostics. */
export function parse(source: string): ParseResult<SequenceDiagram> {
  const { tokens, diagnostics: lexDiags } = lex(source);
  const parser = new Parser(tokens);
  const { ast, diagnostics } = parser.parse();

  const diagnosticsOut: Diagnostic[] = [
    ...diagnostics,
    ...lexDiags.map((diag) =>
      errorDiagnostic(
        diag.message,
        DiagnosticCode.UnsupportedSyntax,
        span(
          { line: diag.line, column: diag.column },
          { line: diag.line, column: diag.column + 1 },
        ),
      ),
    ),
  ];

  return { ast, diagnostics: diagnosticsOut };
}

/** Construct a source range from start and end positions. */
function span(start: SourcePosition, end: SourcePosition): SourceRange {
  return { start, end };
}
