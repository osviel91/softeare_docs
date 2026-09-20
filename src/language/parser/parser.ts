/**
 * Recursive-descent parser for the Sequence Diagram DSL.
 *
 * The parser consumes the flat token stream from {@link lex} and produces a
 * best-effort {@link SequenceDiagram} plus diagnostics. It never throws for bad
 * input: on a syntax error it records a diagnostic, skips to the end of the
 * offending line, and keeps going so the editor stays usable.
 *
 * Grammar (Phase 1; aliases added in Phase 7; notes added in Checkpoint 2):
 *
 *   document     := title? statement* note*
 *   note         := "note" ws* placement (ws* "of" ws* id)? (":" lineText)?
 *   statement    := participant | alias | message
 *   participant  := "participant" ws+ id (ws* quotedLabel)?
 *   alias        := "alias" ws+ id ws* "=" ws* id
 *   message      := id arrow id (":" labelText)?
 *   title        := "title" ws* lineText
 *   placement    := "left" | "right" | "over"
 *
 * Structural rule: participants and aliases must be declared before any message.
 * This mirrors how sequence diagrams are read top-to-bottom and gives the parser
 * a clear phase boundary.
 */
import type {
  AliasNode,
  MessageKind,
  NoteNode,
  NotePlacement,
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
    const ast: SequenceDiagram = {
      participants: [],
      aliases: [],
      statements: [],
      notes: [],
    };
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
      } else if (token.type === TokenType.Alias) {
        // Aliases, like participants, are declarations and must precede any
        // message. They introduce a shorthand usable in later messages.
        if (sawMessage) {
          this.errorHere(
            "Alias must be declared before any message",
            DiagnosticCode.AliasBeforeMessage,
          );
          this.skipToEol();
        } else {
          const alias = this.parseAlias();
          if (alias) ast.aliases.push(alias);
          else this.skipToEol();
        }
      } else if (token.type === TokenType.Note) {
        // A note callout. Notes may appear anywhere in the document and are
        // not messages, so they neither set `sawMessage` nor require the
        // declaration-before-message ordering.
        const note = this.parseNote();
        if (note) ast.notes.push(note);
        else this.skipToEol();
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
    return {
      type: "participant",
      id: idToken.value,
      label: idToken.value,
      range: span(start, end),
    };
  }

  /** Parse an alias declaration line: `alias <shorthand> = <participant>`. */
  private parseAlias(): AliasNode | null {
    const start = this.expect().start;

    // Required shorthand identifier.
    const aliasToken = this.peek();
    if (!aliasToken || aliasToken.type !== TokenType.Identifier) {
      this.errorHere(
        'Expected an alias name after "alias"',
        DiagnosticCode.MalformedMessage,
      );
      return null;
    }
    this.advance();

    // Required `=` separator.
    if (!this.peek() || this.peek()!.type !== TokenType.Equals) {
      this.errorHere(
        "Expected '=' in the alias declaration",
        DiagnosticCode.MalformedMessage,
      );
      return null;
    }
    this.advance();

    // Required target participant name.
    const targetToken = this.peek();
    if (!targetToken || targetToken.type !== TokenType.Identifier) {
      this.errorHere(
        "Expected a participant name after '=' in the alias declaration",
        DiagnosticCode.MalformedMessage,
      );
      return null;
    }
    this.advance();

    // Any trailing tokens on the line are malformed (e.g. a stray label).
    if (this.peek()?.type !== TokenType.Eol && !this.atEnd()) {
      this.errorHere(
        "Unexpected text after the alias target",
        DiagnosticCode.MalformedMessage,
      );
    }

    const end = this.previousEnd();
    return {
      type: "alias",
      alias: aliasToken.value,
      target: targetToken.value,
      range: span(start, end),
    };
  }

  /** Parse a note callout: `note left/right/over [of id] : text`. */
  private parseNote(): NoteNode | null {
    const start = this.expect().start;

    // Required placement keyword: left, right, or over.
    const placementToken = this.peek();
    if (!placementToken || placementToken.type !== TokenType.Identifier) {
      this.errorHere(
        'Expected a note placement (left, right, or over) after "note"',
        DiagnosticCode.MalformedNote,
      );
      return null;
    }
    const placement = this.resolvePlacement(placementToken);
    if (placement === null) {
      this.errorHere(
        `Invalid note placement "${placementToken.value}"; expected left, right, or over`,
        DiagnosticCode.MalformedNote,
      );
      return null;
    }
    this.advance();

    // Optional participant target. `over` may be diagram-wide (no target).
    let participant: ParticipantId | undefined;
    if (placement === "over") {
      if (this.peekKeyword("of")) {
        this.advance(); // tolerate a stray "of" before the id
      } else if (this.peek()?.type === TokenType.Identifier) {
        participant = this.advance().value;
      }
    } else if (this.peekKeyword("of")) {
      this.advance(); // consume "of"
      if (this.peek()?.type !== TokenType.Identifier) {
        this.errorHere(
          `Expected a participant after "of" in a ${placement} note`,
          DiagnosticCode.MalformedNote,
        );
        return null;
      }
      participant = this.advance().value;
    } else if (this.peek()?.type === TokenType.Identifier) {
      // `note left/right <id>` — a bare id anchors the note.
      participant = this.advance().value;
    } else {
      // left / right with no target is malformed; use `note over` for a
      // diagram-wide note.
      this.errorHere(
        `A ${placement} note must reference a participant, e.g. "note ${placement} of User : text"`,
        DiagnosticCode.MalformedNote,
      );
      return null;
    }

    // Required `: text` terminator with a non-empty body.
    if (this.peek()?.type !== TokenType.Colon) {
      this.errorHere(
        "Expected ':' after a note to introduce its text",
        DiagnosticCode.MalformedNote,
      );
      return null;
    }
    this.advance();
    const text = this.readLineText();
    if (text === "") {
      this.errorHere(
        "A note must have text after ':'",
        DiagnosticCode.MalformedNote,
      );
      return null;
    }

    const end = this.previousEnd();
    return {
      type: "note",
      placement,
      participant,
      text,
      range: span(start, end),
    };
  }

  /** Map a placement identifier to its NotePlacement, or null when invalid. */
  private resolvePlacement(token: Token): NotePlacement | null {
    switch (token.value) {
      case "left":
        return "left";
      case "right":
        return "right";
      case "over":
        return "over";
      default:
        return null;
    }
  }

  /** Whether the next token is the bare word `of` (without consuming it). */
  private peekKeyword(word: string): boolean {
    const token = this.peek();
    return token?.type === TokenType.Identifier && token.value === word;
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
      this.errorHere(
        "Expected an arrow (-> or -->) in the message",
        DiagnosticCode.MalformedMessage,
      );
      return null;
    }
    if (arrow.type === TokenType.SyncArrow) this.advance();
    else if (arrow.type === TokenType.ResponseArrow) this.advance();
    else {
      this.errorHere(
        "Expected an arrow (-> or -->) in the message",
        DiagnosticCode.MalformedMessage,
      );
      return null;
    }

    const to = this.peek();
    if (!to || to.type !== TokenType.Identifier) {
      this.errorHere(
        "Expected a receiver participant after the arrow",
        DiagnosticCode.MalformedMessage,
      );
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
    return {
      type: "message",
      kind,
      from: from.value,
      to: to.value,
      label,
      range: span(start, end),
    };
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
    const diagnostic = errorDiagnostic(
      message,
      code,
      span(token.start, token.end),
    );
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
