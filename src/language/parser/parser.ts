/**
 * Recursive-descent parser for the Sequence Diagram DSL.
 *
 * The parser consumes the flat token stream from {@link lex} and produces a
 * best-effort {@link SequenceDiagram} plus diagnostics. It never throws for bad
 * input: on a syntax error it records a diagnostic, skips to the end of the
 * offending line, and keeps going so the editor stays usable.
 *
 * Grammar (extended for the Mermaid-parity backlog; see ADR-013/ADR-014):
 *
 *   document     := line*
 *   line         := title | declaration | note | statement
 *   declaration  := ("participant" | "actor") ws+ id ("as" label)?
 *                 | "alias" ws+ id ws* "=" ws* id
 *   statement    := message | activation | fragment
 *   message      := id arrow ("+" | "-")? id (":" lineText)?
 *   activation   := ("activate" | "deactivate") ws+ id
 *   fragment     := loop | opt | break | alt | par | critical
 *   loop         := "loop" lineText? block "end"
 *   opt          := "opt" lineText? block "end"
 *   break        := "break" lineText? block "end"
 *   alt          := "alt" lineText? block ("else" lineText? block)* "end"
 *   par          := "par" lineText? block ("and" lineText? block)* "end"
 *   critical     := "critical" lineText? block ("option" lineText? block)* "end"
 *   note         := "note" placement participants? (":" lineText | ":" multi "end note")
 *   placement    := "left" | "right" | "over"
 *
 * Inline `+` / `-` on a message is normalized into an activation statement
 * placed immediately before that message, so the bar's edge lines up with the
 * arrow it belongs to (`+` activates the receiver, `-` deactivates the sender).
 *
 * Participants and aliases must be declared before any statement, and a title
 * may appear on any line (a diagram carries at most one). Fragments nest.
 */
import type {
  ActivationAction,
  ActivationNode,
  AliasNode,
  AltBranch,
  ArrowStyle,
  CriticalBranch,
  LineStyle,
  MessageNode,
  SequenceMessageKind,
  SequenceMessageOperation,
  NoteNode,
  NotePlacement,
  ParBranch,
  ParticipantId,
  ParticipantNode,
  ParticipantType,
  SequenceDiagram,
  SourcePosition,
  SourceRange,
  Statement,
} from "../../domain/diagram/ast";
import type { Diagnostic, ParseResult } from "../diagnostics/diagnostics";
import { DiagnosticCode, errorDiagnostic } from "../diagnostics/diagnostics";
import { lex, type Token, TokenType } from "../lexer/lexer";

/** Map every arrow spelling onto the line-style / arrow-style model. */
const ARROW_STYLES: Record<
  string,
  { lineStyle: LineStyle; arrowStyle: ArrowStyle }
> = {
  "->": { lineStyle: "solid", arrowStyle: "arrow" },
  "-->": { lineStyle: "dashed", arrowStyle: "arrow" },
  "->>": { lineStyle: "solid", arrowStyle: "arrow" },
  "-->>": { lineStyle: "dashed", arrowStyle: "arrow" },
  "-x": { lineStyle: "solid", arrowStyle: "cross" },
  "--x": { lineStyle: "dashed", arrowStyle: "cross" },
  "-)": { lineStyle: "solid", arrowStyle: "open" },
  "--)": { lineStyle: "dashed", arrowStyle: "open" },
  "<<->>": { lineStyle: "solid", arrowStyle: "bidirectional" },
  "<<-->>": { lineStyle: "dashed", arrowStyle: "bidirectional" },
};

/** Every arrow spelling, for a helpful error message and for the docs. */
const ARROW_FORMS = Object.keys(ARROW_STYLES).join(", ");

/** A parser that fails closed: it records diagnostics instead of throwing. */
class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  private diagnostics: Diagnostic[] = [];
  /** Where nested notes are collected, so notes inside fragments are kept. */
  private notes: NoteNode[] = [];

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
    this.notes = ast.notes;

    let sawStatement = false;

    while (!this.atEnd()) {
      const token = this.peek()!;
      if (token.type === TokenType.Eol) {
        this.advance();
        continue;
      }

      if (token.type === TokenType.Title) {
        // A title names the diagram. It is metadata rather than a statement, so
        // it may appear on any line; a diagram carries at most one, and a
        // repeated title is reported rather than silently overwriting the first.
        const title = this.parseTitle();
        if (ast.title) {
          this.diagnostics.push(
            errorDiagnostic(
              'A diagram may only declare one "title"',
              DiagnosticCode.DuplicateTitle,
              title.range,
            ),
          );
        } else {
          ast.title = title;
        }
        continue;
      }

      if (
        token.type === TokenType.Participant ||
        token.type === TokenType.Actor
      ) {
        if (sawStatement) {
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
        continue;
      }

      if (token.type === TokenType.Alias) {
        // Aliases, like participants, are declarations and must precede any
        // statement. They introduce a shorthand usable in later messages.
        if (sawStatement) {
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
        continue;
      }

      // Everything else is a statement (or a note, which is collected apart
      // from the statement list but may appear on any line).
      if (this.isStatementStart(token)) sawStatement = true;
      this.parseStatementInto(ast.statements);
    }

    return { ast, diagnostics: this.diagnostics };
  }

  /** Whether a token opens a statement (message, activation, or fragment). */
  private isStatementStart(token: Token): boolean {
    switch (token.type) {
      case TokenType.Identifier:
      case TokenType.Activate:
      case TokenType.Deactivate:
      case TokenType.Loop:
      case TokenType.Alt:
      case TokenType.Opt:
      case TokenType.Par:
      case TokenType.Critical:
      case TokenType.Break:
        return true;
      default:
        return false;
    }
  }

  /** Parse one statement and push it onto `out`. Always makes progress. */
  private parseStatementInto(out: Statement[]): void {
    const token = this.peek();
    if (!token) return;
    switch (token.type) {
      case TokenType.Identifier: {
        const message = this.parseMessage();
        if (message) out.push(...message.statements);
        else this.skipToEol();
        return;
      }
      case TokenType.Semantic: {
        this.parseSemanticMessage(out);
        return;
      }
      case TokenType.Activate:
      case TokenType.Deactivate: {
        const activation = this.parseActivation();
        if (activation) out.push(activation);
        else this.skipToEol();
        return;
      }
      case TokenType.Note: {
        const note = this.parseNote();
        if (note) this.notes.push(note);
        else this.skipToEol();
        return;
      }
      case TokenType.Loop: {
        out.push(this.parseSimpleFragment("loop", "loop"));
        return;
      }
      case TokenType.Opt: {
        out.push(this.parseSimpleFragment("opt", "opt"));
        return;
      }
      case TokenType.Break: {
        out.push(this.parseSimpleFragment("break", "break"));
        return;
      }
      case TokenType.Alt: {
        out.push(this.parseAlternative());
        return;
      }
      case TokenType.Par: {
        out.push(this.parseParallel());
        return;
      }
      case TokenType.Critical: {
        out.push(this.parseCritical());
        return;
      }
      case TokenType.End:
      case TokenType.Else:
      case TokenType.And:
      case TokenType.Option: {
        this.errorHere(
          `"${token.value}" has no matching fragment to close or extend`,
          DiagnosticCode.UnexpectedFragmentKeyword,
        );
        this.skipToEol();
        return;
      }
      default:
        this.errorHere(
          `Unexpected token "${token.value}"`,
          DiagnosticCode.UnsupportedSyntax,
        );
        this.skipToEol();
    }
  }

  /** Parse statements until a terminator keyword or the end of input. */
  private parseStatements(terminators: TokenType[]): Statement[] {
    const statements: Statement[] = [];
    while (!this.atEnd()) {
      const token = this.peek()!;
      if (token.type === TokenType.Eol) {
        this.advance();
        continue;
      }
      if (terminators.includes(token.type)) break;
      this.parseStatementInto(statements);
    }
    return statements;
  }

  /** Parse a title line: `title <text>` where text may be quoted. */
  private parseTitle(): { value: string; range: SourceRange } {
    const start = this.expect().start;
    const value = this.readLineText();
    const end = this.previousEnd();
    return { value, range: span(start, end) };
  }

  /**
   * Parse a participant or actor declaration.
   *
   *   participant <id> [as <label>]
   *   actor <id> [as <label>]
   *
   * The label may be a quoted string or a bare identifier; either way the id
   * stays the stable token messages reference.
   */
  private parseParticipant(): ParticipantNode | null {
    const keyword = this.expect();
    const start = keyword.start;
    const participantType: ParticipantType =
      keyword.type === TokenType.Actor ? "actor" : "participant";
    const keywordLabel = participantType === "actor" ? "actor" : "participant";

    const idToken = this.peek();
    if (!idToken || idToken.type !== TokenType.Identifier) {
      this.errorHere(
        `Expected a name after "${keywordLabel}"`,
        DiagnosticCode.MalformedParticipant,
      );
      return null;
    }
    this.advance();

    let label = idToken.value;
    if (this.peekKeyword("as")) {
      this.advance();
      const labelToken = this.peek();
      if (
        labelToken &&
        (labelToken.type === TokenType.StringLiteral ||
          labelToken.type === TokenType.Identifier)
      ) {
        label = this.advance().value;
      } else {
        this.errorHere(
          `Expected a label after "as" in the ${keywordLabel} declaration`,
          DiagnosticCode.MalformedParticipant,
        );
        return null;
      }
    }

    // Any trailing tokens on the line are malformed.
    if (this.peek() && this.peek()!.type !== TokenType.Eol) {
      this.errorHere(
        `Unexpected text after the ${keywordLabel} declaration`,
        DiagnosticCode.MalformedParticipant,
      );
    }

    const end = this.previousEnd();
    return {
      type: "participant",
      participantType,
      id: idToken.value,
      label,
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

  /**
   * Parse a note callout.
   *
   *   note left|right|over [of] <id> : text
   *   note over <id> (, <id>)* : text          — spanning note
   *   note over : text                         — diagram-wide
   *   note on <number> : text                  — attached to a message step
   *   note <placement> <target>:               — multiline form
   *     line
   *     line
   *   end note
   */
  private parseNote(): NoteNode | null {
    const start = this.expect().start;

    // Required placement keyword: left, right, over, or on.
    const placementToken = this.peek();
    if (!placementToken || placementToken.type !== TokenType.Identifier) {
      this.errorHere(
        'Expected a note placement (left, right, over, or on) after "note"',
        DiagnosticCode.MalformedNote,
      );
      return null;
    }
    const placement = this.resolvePlacement(placementToken);
    if (placement === null) {
      this.errorHere(
        `Invalid note placement "${placementToken.value}"; expected left, right, over, or on`,
        DiagnosticCode.MalformedNote,
      );
      return null;
    }
    this.advance();

    const participants: ParticipantId[] = [];
    let messageNumber: number | undefined;
    if (placement === "on") {
      // `note on <n>` attaches to the message whose circled step number is `n`.
      const numberToken = this.peek();
      if (!numberToken || numberToken.type !== TokenType.Number) {
        this.errorHere(
          'Expected a message number after "note on", e.g. "note on 3 : text"',
          DiagnosticCode.MalformedNote,
        );
        return null;
      }
      this.advance();
      messageNumber = Number.parseInt(numberToken.value, 10);
      if (!Number.isInteger(messageNumber) || messageNumber < 1) {
        this.errorHere(
          "A note's message number must be a positive whole number",
          DiagnosticCode.MalformedNote,
        );
        return null;
      }
    } else if (placement === "over") {
      // `of` is optional and tolerated for symmetry with left/right.
      if (this.peekKeyword("of")) this.advance();
      if (this.peek()?.type === TokenType.Identifier) {
        participants.push(this.advance().value);
        // One or more comma-separated participants make the note span them.
        while (this.peek()?.type === TokenType.Comma) {
          this.advance();
          const next = this.peek();
          if (!next || next.type !== TokenType.Identifier) {
            this.errorHere(
              "Expected a participant after ',' in a spanning note",
              DiagnosticCode.MalformedSpanningNote,
            );
            return null;
          }
          participants.push(this.advance().value);
        }
      }
    } else {
      if (this.peekKeyword("of")) this.advance(); // consume "of"
      const target = this.peek();
      if (!target || target.type !== TokenType.Identifier) {
        this.errorHere(
          `A ${placement} note must reference a participant, e.g. "note ${placement} of User : text"`,
          DiagnosticCode.MalformedNote,
        );
        return null;
      }
      participants.push(this.advance().value);
    }

    // Required `:` terminator introducing the text.
    if (this.peek()?.type !== TokenType.Colon) {
      this.errorHere(
        "Expected ':' after a note to introduce its text",
        DiagnosticCode.MalformedNote,
      );
      return null;
    }
    this.advance();

    const inline = this.readLineText();
    let text = inline;
    if (inline === "") {
      // Nothing after the colon: the multiline form, ended by `end note`.
      if (this.peekMultilineNoteEnd()) {
        this.errorHere(
          "A note must have text after ':'",
          DiagnosticCode.MalformedNote,
        );
        return null;
      }
      const body = this.readMultilineNote();
      if (!body.closed) {
        this.errorHere(
          'Expected "end note" to close the multiline note',
          DiagnosticCode.MalformedNote,
        );
        return null;
      }
      if (body.text === "") {
        this.errorHere(
          'A note must have text; add it after ":" or use "end note" to close a multiline note',
          DiagnosticCode.MalformedNote,
        );
        return null;
      }
      text = body.text;
    }

    const end = this.previousEnd();
    return {
      type: "note",
      placement,
      participants,
      messageNumber,
      text,
      range: span(start, end),
    };
  }

  /** Read a multiline note body until the `end note` terminator. */
  private readMultilineNote(): { text: string; closed: boolean } {
    const lines: string[] = [];
    let closed = false;
    while (!this.atEnd()) {
      if (this.peekMultilineNoteEnd()) {
        this.advance(); // `end`
        this.advance(); // `note`
        if (this.peek() && this.peek()!.type !== TokenType.Eol) {
          this.errorHere(
            'Unexpected text after "end note"',
            DiagnosticCode.MalformedNote,
          );
        }
        this.skipToEol();
        closed = true;
        break;
      }
      lines.push(this.readLineText());
    }
    // Drop blank leading/trailing lines so the box is not padded with air.
    while (lines.length > 0 && lines[0] === "") lines.shift();
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return { text: lines.join("\n"), closed };
  }

  /** Whether the cursor is at an `end note` terminator. */
  private peekMultilineNoteEnd(): boolean {
    return (
      this.peek()?.type === TokenType.End &&
      this.peekAt(1)?.type === TokenType.Note
    );
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
      case "on":
        return "on";
      default:
        return null;
    }
  }

  /** Whether the next token is the bare word `of` (without consuming it). */
  private peekKeyword(word: string): boolean {
    const token = this.peek();
    return token?.type === TokenType.Identifier && token.value === word;
  }

  /** Parse an activation line: `activate <id>` or `deactivate <id>`. */
  private parseActivation(): ActivationNode | null {
    const keyword = this.expect();
    const action: ActivationAction =
      keyword.type === TokenType.Activate ? "activate" : "deactivate";
    const start = keyword.start;

    const target = this.peek();
    if (!target || target.type !== TokenType.Identifier) {
      this.errorHere(
        `Expected a participant name after "${action}"`,
        DiagnosticCode.MalformedActivation,
      );
      return null;
    }
    this.advance();

    // Any trailing tokens on the line are malformed (activations take no label).
    if (this.peek()?.type !== TokenType.Eol && !this.atEnd()) {
      this.errorHere(
        `Unexpected text after the "${action}" target`,
        DiagnosticCode.MalformedActivation,
      );
    }

    const end = this.previousEnd();
    return {
      type: "activation",
      action,
      participant: target.value,
      range: span(start, end),
    };
  }

  /**
   * Parse a message line: `from arrow ("+" | "-")? to (":" label)?`.
   *
   * Returns the statements the line produces: an optional inline activation
   * first (so its bar edge aligns with this message's row), then the message.
   */
  private parseMessage(): { statements: Statement[] } | null {
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
    if (!arrow || arrow.type !== TokenType.Arrow) {
      this.errorHere(
        `Expected an arrow (${ARROW_FORMS}) in the message`,
        DiagnosticCode.MalformedMessage,
      );
      return null;
    }
    this.advance();
    const style = ARROW_STYLES[arrow.value];

    // Inline activation suffix: `+` activates the receiver, `-` deactivates the
    // sender (matching Mermaid's `->>+B` / `-->>-A` shorthand).
    let inline: ActivationAction | null = null;
    if (this.peek()?.type === TokenType.Plus) {
      inline = "activate";
      this.advance();
    } else if (this.peek()?.type === TokenType.Minus) {
      inline = "deactivate";
      this.advance();
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

    let label = "";
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
    const statements: Statement[] = [];
    if (inline) {
      statements.push({
        type: "activation",
        action: inline,
        participant: inline === "activate" ? to.value : from.value,
        range: span(start, end),
      });
    }
    const message: MessageNode = {
      type: "message",
      lineStyle: style.lineStyle,
      arrowStyle: style.arrowStyle,
      from: from.value,
      to: to.value,
      label,
      range: span(start, end),
    };
    statements.push(message);
    return { statements };
  }

  /** Attach explicit architectural meaning to the immediately preceding message. */
  private parseSemanticMessage(out: Statement[]): void {
    const semantic = this.advance();
    const previous = out.at(-1);
    if (!previous || previous.type !== "message") {
      this.errorHere(
        '"semantic" must immediately follow a message',
        DiagnosticCode.MalformedSemanticMessage,
      );
      this.skipToEol();
      return;
    }
    if (previous.semantics) {
      this.errorHere(
        "A message may declare semantic metadata only once",
        DiagnosticCode.MalformedSemanticMessage,
      );
      this.skipToEol();
      return;
    }

    const kindToken = this.peek();
    const operationToken = this.peekAt(1);
    const nameToken = this.peekAt(2);
    const kind = kindToken?.value;
    const operation = operationToken?.value;
    if (
      (kind !== "event" && kind !== "command") ||
      (operation !== "publish" && operation !== "consume" && operation !== "dispatch") ||
      !nameToken ||
      nameToken.type !== TokenType.Identifier
    ) {
      this.errorHere(
        "Expected: semantic event|command publish|consume|dispatch <message-name>",
        DiagnosticCode.MalformedSemanticMessage,
      );
      this.skipToEol();
      return;
    }
    this.advance();
    this.advance();
    this.advance();
    let messageRef: string | undefined;
    if (this.peek()?.value === "messageRef") {
      this.advance();
      const reference = this.peek();
      if (!reference || reference.type !== TokenType.Identifier) {
        this.errorHere(
          "Expected a stable semantic message id after messageRef",
          DiagnosticCode.MalformedSemanticMessage,
        );
      } else {
        messageRef = reference.value;
        this.advance();
      }
    }
    if (this.peek()?.type !== TokenType.Eol && !this.atEnd()) {
      this.errorHere(
        "Unexpected text after semantic message metadata",
        DiagnosticCode.MalformedSemanticMessage,
      );
    }
    previous.semantics = {
      name: nameToken.value,
      kind: kind as SequenceMessageKind,
      operation: operation as SequenceMessageOperation,
      ...(messageRef ? { messageRef } : {}),
      range: span(semantic.start, this.previousEnd()),
    };
  }

  /** Parse a single-block fragment (`loop`, `opt`, `break`). */
  private parseSimpleFragment(
    name: "loop" | "opt" | "break",
    keywordLabel: string,
  ): Statement {
    const start = this.expect().start;
    const label = this.readLineText();
    const statements = this.parseStatements([TokenType.End]);
    const end = this.expectEnd(keywordLabel, start);
    return { type: name, label, statements, range: span(start, end) };
  }

  /** Parse an `alt`/`else` fragment. */
  private parseAlternative(): Statement {
    const start = this.expect().start;
    const first = this.readLineText();

    const branches: AltBranch[] = [];
    let condition = first;
    let branchStart = start;
    for (;;) {
      const statements = this.parseStatements([TokenType.End, TokenType.Else]);
      branches.push({
        condition,
        statements,
        range: span(branchStart, this.statementEnd(statements, branchStart)),
      });
      if (this.peek()?.type === TokenType.Else) {
        branchStart = this.advance().start;
        condition = this.readLineText();
        continue;
      }
      break;
    }
    const end = this.expectEnd("alt", start);
    return { type: "alt", branches, range: span(start, end) };
  }

  /** Parse a `par`/`and` fragment. */
  private parseParallel(): Statement {
    const start = this.expect().start;
    let label = this.readLineText();

    const branches: ParBranch[] = [];
    let branchStart = start;
    for (;;) {
      const statements = this.parseStatements([TokenType.End, TokenType.And]);
      branches.push({
        label,
        statements,
        range: span(branchStart, this.statementEnd(statements, branchStart)),
      });
      if (this.peek()?.type === TokenType.And) {
        branchStart = this.advance().start;
        label = this.readLineText();
        continue;
      }
      break;
    }
    const end = this.expectEnd("par", start);
    return { type: "par", branches, range: span(start, end) };
  }

  /** Parse a `critical`/`option` fragment. */
  private parseCritical(): Statement {
    const start = this.expect().start;
    let label = this.readLineText();

    const branches: CriticalBranch[] = [];
    let branchStart = start;
    for (;;) {
      const statements = this.parseStatements([
        TokenType.End,
        TokenType.Option,
      ]);
      branches.push({
        label,
        statements,
        range: span(branchStart, this.statementEnd(statements, branchStart)),
      });
      if (this.peek()?.type === TokenType.Option) {
        branchStart = this.advance().start;
        label = this.readLineText();
        continue;
      }
      break;
    }
    const end = this.expectEnd("critical", start);
    return { type: "critical", branches, range: span(start, end) };
  }

  /** End position for a branch span: its last statement, or its start. */
  private statementEnd(
    statements: Statement[],
    fallback: SourcePosition,
  ): SourcePosition {
    const last = statements[statements.length - 1];
    return last ? last.range.end : fallback;
  }

  /** Consume the `end` that closes a fragment, reporting when it is missing. */
  private expectEnd(name: string, start: SourcePosition): SourcePosition {
    const token = this.peek();
    if (token && token.type === TokenType.End) {
      this.advance();
      if (this.peek() && this.peek()!.type !== TokenType.Eol) {
        this.errorHere(
          'Unexpected text after "end"',
          DiagnosticCode.MalformedFragment,
        );
      }
      this.skipToEol();
      return this.previousEnd();
    }
    this.errorHere(
      `Expected "end" to close the ${name}`,
      DiagnosticCode.UnclosedFragment,
    );
    // Fall back to the last consumed token so the range stays valid.
    return this.tokens[Math.max(0, this.pos - 1)]?.end ?? start;
  }

  /** Read the remaining raw text of the current line, then consume the line. */
  private readLineText(): string {
    const eol = this.currentLineEol();
    const first = this.peek();
    let value =
      first && first.type !== TokenType.Eol
        ? eol.value.slice(first.start.column, eol.start.column).trim()
        : "";
    // A value wrapped entirely in double quotes is a quoted literal: drop the
    // quotes (and any padding inside them), matching the token-based reading.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).trim();
    }
    this.skipToEol();
    return value;
  }

  /** The `Eol` token that ends the line the cursor is on. */
  private currentLineEol(): Token {
    for (let i = this.pos; i < this.tokens.length; i++) {
      if (this.tokens[i].type === TokenType.Eol) return this.tokens[i];
    }
    return this.tokens[this.tokens.length - 1]!;
  }

  // --- Token cursor helpers -------------------------------------------------

  private atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private peekAt(offset: number): Token | undefined {
    return this.tokens[this.pos + offset];
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
    const token = this.peek() ?? this.tokens[this.tokens.length - 1]!;
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
