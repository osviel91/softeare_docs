import { describe, expect, it } from "vitest";
import type { SequenceDiagram } from "../../src/domain/diagram/ast";
import { DiagnosticCode } from "../../src/language/diagnostics/diagnostics";
import { parse } from "../../src/language/parser/parser";

const LOGIN_EXAMPLE = `title Login

participant User
participant API
participant DB

User -> API: Login
API -> DB: Find user
DB --> API: User
API --> User: Token
`;

describe("parse — valid input", () => {
  it("parses an explicit semantic message identity reference", () => {
    const { ast } = parse(`participant A\nparticipant B\nA -> B: created\nsemantic event publish Created messageRef msg-created\n`);
    expect(ast?.statements.at(-1)).toMatchObject({
      type: "message",
      semantics: { name: "Created", kind: "event", operation: "publish", messageRef: "msg-created" },
    });
  });
  it("parses the login example into the expected AST", () => {
    const { ast, diagnostics } = parse(LOGIN_EXAMPLE);
    expect(diagnostics).toEqual([]);
    expect(ast).not.toBeNull();

    const diagram: SequenceDiagram = ast as unknown as SequenceDiagram;
    expect(diagram.title?.value).toBe("Login");
    expect(diagram.participants.map((p) => p.id)).toEqual([
      "User",
      "API",
      "DB",
    ]);
    // Labels default to the id when no quoted label is given.
    expect(diagram.participants.map((p) => p.label)).toEqual([
      "User",
      "API",
      "DB",
    ]);
    expect(diagram.statements).toHaveLength(4);
  });

  it("maps every arrow spelling onto line and arrow style", () => {
    const { ast } = parse(
      [
        "participant A",
        "participant B",
        "A -> B: a",
        "A --> B: b",
        "A ->> B: c",
        "A -->> B: d",
        "A -x B: e",
        "A --x B: f",
        "A -) B: g",
        "A --) B: h",
        "A <<->> B: i",
        "A <<-->> B: j",
      ].join("\n"),
    );
    const statements = (ast as unknown as SequenceDiagram).statements;
    expect(statements.map((s) => s.type)).toEqual(
      Array.from({ length: 10 }, () => "message"),
    );
    const styles = statements.map((s) =>
      s.type === "message" ? [s.lineStyle, s.arrowStyle] : ["?", "?"],
    );
    expect(styles).toEqual([
      ["solid", "arrow"],
      ["dashed", "arrow"],
      ["solid", "arrow"],
      ["dashed", "arrow"],
      ["solid", "cross"],
      ["dashed", "cross"],
      ["solid", "open"],
      ["dashed", "open"],
      ["solid", "bidirectional"],
      ["dashed", "bidirectional"],
    ]);
  });

  it("captures message endpoints and empty labels", () => {
    const { ast } = parse("participant A\nparticipant B\nA -> B");
    const statement = (ast as unknown as SequenceDiagram).statements[0];
    expect(statement).toMatchObject({ from: "A", to: "B", label: "" });
  });

  it("parses evidence-backed event and command occurrences without changing steps", () => {
    const { ast, diagnostics } = parse(`participant Transaction
participant Handler
Transaction -->> Handler: MslTransactionCreatedEvent
semantic event publish MslTransactionCreatedEvent
Handler -> Handler: Handle MslTransactionCreatedEvent
semantic event consume MslTransactionCreatedEvent
Handler -> Handler: SendEmailCommand
semantic command dispatch SendEmailCommand`);
    expect(diagnostics).toEqual([]);
    const diagram = ast!;
    expect(diagram.statements).toHaveLength(3);
    expect(diagram.statements[0]).toMatchObject({
      type: "message",
      semantics: {
        name: "MslTransactionCreatedEvent",
        kind: "event",
        operation: "publish",
      },
    });
    expect(diagram.statements[1]).toMatchObject({
      semantics: { kind: "event", operation: "consume" },
    });
    expect(diagram.statements[2]).toMatchObject({
      semantics: { kind: "command", operation: "dispatch" },
    });
  });

  it("rejects orphan semantic metadata and keeps legacy input valid", () => {
    const orphan = parse("semantic event publish Something");
    expect(orphan.diagnostics.map((entry) => entry.code)).toContain(
      DiagnosticCode.MalformedSemanticMessage,
    );
    expect(parse(LOGIN_EXAMPLE).diagnostics).toEqual([]);
  });

  it("keeps semantic occurrences inside fragments and self-messages numbered", () => {
    const { ast, diagnostics } = parse(`participant A
loop retry
  A -> A: RetryCommand
  semantic command dispatch RetryCommand
end
A -> A: DoneEvent
semantic event publish DoneEvent`);
    expect(diagnostics).toEqual([]);
    expect(ast!.statements[0].type).toBe("loop");
    const loop = ast!.statements[0];
    if (loop.type === "loop") {
      expect(loop.statements[0]).toMatchObject({
        semantics: { kind: "command", operation: "dispatch" },
      });
    }
    expect(ast!.statements[1]).toMatchObject({
      semantics: { kind: "event", operation: "publish" },
    });
  });

  it("keeps a long label intact", () => {
    const longLabel = "x".repeat(200);
    const { ast } = parse(`participant A\nparticipant B\nA -> B: ${longLabel}`);
    const statement = (ast as unknown as SequenceDiagram).statements[0];
    expect(statement).toMatchObject({ type: "message", label: longLabel });
  });

  it("skips blank lines without error", () => {
    const { ast, diagnostics } = parse(
      "\n\nparticipant A\n\nparticipant B\n\nA -> B: hi\n\n",
    );
    expect(diagnostics).toEqual([]);
    expect((ast as unknown as SequenceDiagram).participants).toHaveLength(2);
  });

  it("parses an actor declaration, distinct from a participant", () => {
    const { ast, diagnostics } = parse("actor User\nparticipant API");
    expect(diagnostics).toEqual([]);
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.participants.map((p) => p.participantType)).toEqual([
      "actor",
      "participant",
    ]);
  });

  it("parses a quoted label with 'as'", () => {
    const { ast, diagnostics } = parse(
      'participant api as "Authentication API"\nactor user as "End User"',
    );
    expect(diagnostics).toEqual([]);
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.participants[0]).toMatchObject({
      id: "api",
      label: "Authentication API",
      participantType: "participant",
    });
    expect(diagram.participants[1]).toMatchObject({
      id: "user",
      label: "End User",
      participantType: "actor",
    });
  });

  it("accepts an unquoted 'as' label", () => {
    const { ast, diagnostics } = parse("participant db as Database");
    expect(diagnostics).toEqual([]);
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.participants[0]).toMatchObject({
      id: "db",
      label: "Database",
    });
  });
});

describe("parse — titles", () => {
  it("accepts a title on any line, not just the first", () => {
    const { ast, diagnostics } = parse(
      "participant A\nparticipant B\ntitle Added Later\nA -> B: hi",
    );
    expect(diagnostics).toEqual([]);
    expect((ast as unknown as SequenceDiagram).title?.value).toBe(
      "Added Later",
    );
  });

  it("accepts a title after messages, since it is metadata", () => {
    const { ast, diagnostics } = parse("participant A\nA -> A: hi\ntitle Late");
    expect(diagnostics).toEqual([]);
    expect((ast as unknown as SequenceDiagram).title?.value).toBe("Late");
  });

  it("reads a quoted title as a single value", () => {
    const { ast } = parse('title "Authentication Flow"');
    expect((ast as unknown as SequenceDiagram).title?.value).toBe(
      "Authentication Flow",
    );
  });

  it("keeps the first title and reports a repeated one", () => {
    const { ast, diagnostics } = parse(
      "title First\nparticipant A\ntitle Second",
    );
    expect((ast as unknown as SequenceDiagram).title?.value).toBe("First");
    expect(diagnostics.map((d) => d.code)).toContain(
      DiagnosticCode.DuplicateTitle,
    );
  });
});

describe("parse — malformed input", () => {
  it("never throws on incomplete input", () => {
    expect(() => parse("participant A\nA ->")).not.toThrow();
    expect(() => parse("")).not.toThrow();
    expect(() => parse("\n\n\n")).not.toThrow();
  });

  it("flags a message missing its arrow", () => {
    const { diagnostics } = parse("participant A\nparticipant B\nA B: hi");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedMessage),
    ).toBe(true);
  });

  it("flags trailing text without a colon", () => {
    const { diagnostics } = parse("participant A\nparticipant B\nA -> B extra");
    expect(
      diagnostics.some((d) =>
        d.message.includes("Expected ':' after message receiver"),
      ),
    ).toBe(true);
  });

  it("flags a missing receiver after the arrow", () => {
    const { diagnostics } = parse("participant A\nA -> : hi");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedMessage),
    ).toBe(true);
  });

  it("flags an unexpected leading token", () => {
    const { diagnostics } = parse("@@@ garbage");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.UnsupportedSyntax),
    ).toBe(true);
  });

  it("reports an unterminated string literal", () => {
    const { diagnostics } = parse('participant "oops');
    expect(
      diagnostics.some((d) => d.message.includes("Unterminated string")),
    ).toBe(true);
  });

  it("flags a participant name missing", () => {
    const { diagnostics } = parse("participant\nA -> B: hi");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedParticipant),
    ).toBe(true);
  });
});

describe("parse — structural rules", () => {
  it("requires participants to be declared before messages", () => {
    const { diagnostics } = parse("A -> B: hi\nparticipant A\nparticipant B");
    expect(
      diagnostics.some((d) =>
        d.message.includes("declared before any message"),
      ),
    ).toBe(true);
  });

  it("still collects the messages even when a rule is violated", () => {
    const { ast } = parse("A -> B: hi\nparticipant A\nparticipant B");
    expect(
      (ast as unknown as SequenceDiagram).statements.length,
    ).toBeGreaterThan(0);
  });
});

describe("parse — aliases", () => {
  it("parses a well-formed alias declaration", () => {
    const { ast, diagnostics } = parse(
      "participant User\nalias U = User\nU -> U: hi",
    );
    expect(diagnostics).toEqual([]);
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.aliases).toHaveLength(1);
    expect(diagram.aliases[0]).toMatchObject({
      type: "alias",
      alias: "U",
      target: "User",
    });
  });

  it("allows whitespace around the '=' separator", () => {
    const { ast } = parse("participant User\nalias   U    =    User");
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.aliases).toHaveLength(1);
    expect(diagram.aliases[0]).toMatchObject({ alias: "U", target: "User" });
  });

  it("collects multiple aliases in order", () => {
    const { ast } = parse(
      "participant A\nparticipant B\nalias X = A\nalias Y = B",
    );
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.aliases.map((a) => a.alias)).toEqual(["X", "Y"]);
  });

  it("flags an alias missing its shorthand name", () => {
    const { diagnostics } = parse("alias = User");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedMessage),
    ).toBe(true);
  });

  it("flags an alias missing the '=' separator", () => {
    const { diagnostics } = parse("alias U User");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedMessage),
    ).toBe(true);
  });

  it("flags an alias missing its target name", () => {
    const { diagnostics } = parse("alias U =");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedMessage),
    ).toBe(true);
  });

  it("flags trailing text after the alias target", () => {
    const { diagnostics } = parse("alias U = User: extra");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedMessage),
    ).toBe(true);
  });

  it("requires aliases to be declared before messages", () => {
    const { diagnostics } = parse("U -> U: hi\nalias U = User");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.AliasBeforeMessage),
    ).toBe(true);
  });

  it("never throws on a malformed alias line", () => {
    expect(() => parse("alias =")).not.toThrow();
  });
});

describe("parse — notes", () => {
  it("parses a left note anchored to a participant", () => {
    const { ast, diagnostics } = parse("note left of User : secret");
    expect(diagnostics).toEqual([]);
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.notes).toHaveLength(1);
    expect(diagram.notes[0]).toMatchObject({
      type: "note",
      placement: "left",
      participants: ["User"],
      text: "secret",
    });
  });

  it("parses a right note anchored to a participant", () => {
    const { ast } = parse("note right of API : hi");
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.notes[0]).toMatchObject({
      placement: "right",
      participants: ["API"],
      text: "hi",
    });
  });

  it("parses an over note anchored to a participant", () => {
    const { ast } = parse("note over User : span");
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.notes[0]).toMatchObject({
      placement: "over",
      participants: ["User"],
      text: "span",
    });
  });

  it("parses a diagram-wide over note with no participant", () => {
    const { ast } = parse("note over : shared");
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.notes[0]).toMatchObject({
      placement: "over",
      text: "shared",
    });
    expect(diagram.notes[0].participants).toEqual([]);
  });

  it("parses a spanning over note over comma-separated participants", () => {
    const { ast, diagnostics } = parse(
      "note over API,DB : Transaction boundary",
    );
    expect(diagnostics).toEqual([]);
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.notes[0]).toMatchObject({
      placement: "over",
      participants: ["API", "DB"],
      text: "Transaction boundary",
    });
  });

  it("parses a multiline note body until 'end note'", () => {
    const { ast, diagnostics } = parse(
      [
        "note right of API:",
        "Validate JWT",
        "Check expiration",
        "Load permissions",
        "end note",
      ].join("\n"),
    );
    expect(diagnostics).toEqual([]);
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.notes[0]?.text).toBe(
      "Validate JWT\nCheck expiration\nLoad permissions",
    );
    expect(diagram.notes[0]?.participants).toEqual(["API"]);
  });

  it("flags a multiline note that is never closed", () => {
    const { diagnostics } = parse("note right of API:\nfirst line");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedNote),
    ).toBe(true);
  });

  it("parses a note attached to a message by its step number", () => {
    const { ast, diagnostics } = parse(
      "participant User\nparticipant API\nUser ->> API: Login\nnote on 1 : Retried once",
    );
    expect(diagnostics).toEqual([]);
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.notes[0]).toMatchObject({
      placement: "on",
      messageNumber: 1,
      participants: [],
      text: "Retried once",
    });
  });

  it("allows a multiline note on a message", () => {
    const { ast, diagnostics } = parse(
      [
        "participant A",
        "participant B",
        "A ->> B: Go",
        "note on 1:",
        "first",
        "second",
        "end note",
      ].join("\n"),
    );
    expect(diagnostics).toEqual([]);
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.notes[0]?.messageNumber).toBe(1);
    expect(diagram.notes[0]?.text).toBe("first\nsecond");
  });

  it("flags a note on a missing or non-numeric message number", () => {
    const missing = parse("note on : text");
    expect(
      missing.diagnostics.some((d) => d.code === DiagnosticCode.MalformedNote),
    ).toBe(true);

    const notANumber = parse("note on first : text");
    expect(
      notANumber.diagnostics.some(
        (d) => d.code === DiagnosticCode.MalformedNote,
      ),
    ).toBe(true);
  });

  it("accepts a bare id for left/right without 'of'", () => {
    const { ast } = parse("note left User : bare");
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.notes[0]).toMatchObject({
      placement: "left",
      participants: ["User"],
      text: "bare",
    });
  });

  it("collects multiple notes in source order", () => {
    const { ast } = parse(
      "note left of A : one\nnote over B : two\nnote right of C : three",
    );
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.notes.map((n) => n.text)).toEqual(["one", "two", "three"]);
    expect(diagram.notes.map((n) => n.placement)).toEqual([
      "left",
      "over",
      "right",
    ]);
  });

  it("flags an invalid note placement", () => {
    const { diagnostics } = parse("note sideways of User : hi");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedNote),
    ).toBe(true);
  });

  it("flags a left/right note missing its participant", () => {
    const { diagnostics } = parse("note left : hi");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedNote),
    ).toBe(true);
  });

  it("flags a note missing its ':' text terminator", () => {
    const { diagnostics } = parse("note left of User");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedNote),
    ).toBe(true);
  });

  it("flags a note with no text after ':'", () => {
    const { diagnostics } = parse("note left of User :");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedNote),
    ).toBe(true);
  });

  it("never throws on a malformed note line", () => {
    expect(() => parse("note\n")).not.toThrow();
    expect(() => parse("note left of")).not.toThrow();
  });
});

describe("parse — activations", () => {
  it("parses activate and deactivate statements in source order", () => {
    const { ast, diagnostics } = parse(
      "participant A\nactivate A\nA -> A: work\ndeactivate A",
    );
    expect(diagnostics).toEqual([]);
    const statements = (ast as unknown as SequenceDiagram).statements;
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatchObject({
      type: "activation",
      action: "activate",
      participant: "A",
    });
    expect(statements[2]).toMatchObject({
      type: "activation",
      action: "deactivate",
      participant: "A",
    });
  });

  it("flags an activation with no participant target", () => {
    const { diagnostics } = parse("participant A\nactivate");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedActivation),
    ).toBe(true);
  });

  it("flags trailing text after the activation target", () => {
    const { diagnostics } = parse("participant A\nactivate A now");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedActivation),
    ).toBe(true);
  });

  it("never throws on a malformed activation line", () => {
    expect(() => parse("activate\n")).not.toThrow();
    expect(() => parse("deactivate\n")).not.toThrow();
  });

  it("normalizes an inline '+' into an activation of the receiver", () => {
    const { ast, diagnostics } = parse(
      "participant A\nparticipant B\nA ->>+ B: go",
    );
    expect(diagnostics).toEqual([]);
    const statements = (ast as unknown as SequenceDiagram).statements;
    expect(statements.map((s) => s.type)).toEqual(["activation", "message"]);
    expect(statements[0]).toMatchObject({
      type: "activation",
      action: "activate",
      participant: "B",
    });
  });

  it("normalizes an inline '-' into a deactivation of the sender", () => {
    const { ast, diagnostics } = parse(
      "participant A\nparticipant B\nB -->>- A: done",
    );
    expect(diagnostics).toEqual([]);
    const statements = (ast as unknown as SequenceDiagram).statements;
    expect(statements[0]).toMatchObject({
      type: "activation",
      action: "deactivate",
      participant: "B",
    });
  });
});

describe("parse — control-flow fragments", () => {
  it("parses a loop with nested statements, closed by end", () => {
    const { ast, diagnostics } = parse(
      [
        "participant C",
        "participant S",
        "loop retry up to 3 times",
        "  C ->> S: Request",
        "  S -->> C: Failure",
        "end",
      ].join("\n"),
    );
    expect(diagnostics).toEqual([]);
    const statements = (ast as unknown as SequenceDiagram).statements;
    expect(statements).toHaveLength(1);
    const loop = statements[0];
    expect(loop).toMatchObject({ type: "loop", label: "retry up to 3 times" });
    expect(loop.type === "loop" && loop.statements).toHaveLength(2);
  });

  it("parses alt/else branches with their conditions", () => {
    const { ast, diagnostics } = parse(
      [
        "participant A",
        "participant B",
        "alt user exists",
        "  A ->> B: Load",
        "else user missing",
        "  B -->> A: 404",
        "end",
      ].join("\n"),
    );
    expect(diagnostics).toEqual([]);
    const alt = (ast as unknown as SequenceDiagram).statements[0];
    expect(alt.type).toBe("alt");
    if (alt.type === "alt") {
      expect(alt.branches.map((b) => b.condition)).toEqual([
        "user exists",
        "user missing",
      ]);
      expect(alt.branches.map((b) => b.statements.length)).toEqual([1, 1]);
    }
  });

  it("parses opt, par/and, critical/option and break", () => {
    const { ast, diagnostics } = parse(
      [
        "participant A",
        "participant B",
        "opt extra",
        "  A ->> B: x",
        "end",
        "par first",
        "  A ->> B: one",
        "and second",
        "  B -->> A: two",
        "end",
        "critical must succeed",
        "  A ->> B: critical",
        "option on failure",
        "  B -->> A: error",
        "end",
        "break aborted",
        "  A ->> B: stop",
        "end",
      ].join("\n"),
    );
    expect(diagnostics).toEqual([]);
    const kinds = (ast as unknown as SequenceDiagram).statements.map(
      (s) => s.type,
    );
    expect(kinds).toEqual(["opt", "par", "critical", "break"]);
  });

  it("nests fragments", () => {
    const { ast, diagnostics } = parse(
      [
        "participant A",
        "participant B",
        "loop outer",
        "  opt inner",
        "    A ->> B: deep",
        "  end",
        "end",
      ].join("\n"),
    );
    expect(diagnostics).toEqual([]);
    const outer = (ast as unknown as SequenceDiagram).statements[0];
    expect(outer.type).toBe("loop");
    if (outer.type === "loop") {
      expect(outer.statements[0]?.type).toBe("opt");
    }
  });

  it("flags a fragment that is never closed", () => {
    const { diagnostics } = parse("participant A\nloop forever\nA ->> A: x");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.UnclosedFragment),
    ).toBe(true);
  });

  it("flags a stray end with no open fragment", () => {
    const { diagnostics } = parse("participant A\nend");
    expect(
      diagnostics.some(
        (d) => d.code === DiagnosticCode.UnexpectedFragmentKeyword,
      ),
    ).toBe(true);
  });

  it("keeps parsing after a stray fragment separator", () => {
    const { ast, diagnostics } = parse("participant A\nelse oops\nA ->> A: x");
    expect(
      diagnostics.some(
        (d) => d.code === DiagnosticCode.UnexpectedFragmentKeyword,
      ),
    ).toBe(true);
    expect((ast as unknown as SequenceDiagram).statements).toHaveLength(1);
  });

  it("never throws on malformed fragments", () => {
    expect(() => parse("loop")).not.toThrow();
    expect(() => parse("alt\nelse\nend")).not.toThrow();
    expect(() => parse("critical\noption\nend")).not.toThrow();
  });
});
