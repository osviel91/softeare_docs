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

  it("classifies sync and response messages", () => {
    const { ast } = parse(
      "participant A\nparticipant B\nA -> B: hi\nB --> A: bye",
    );
    const statements = (ast as unknown as SequenceDiagram).statements;
    expect(statements[0]).toMatchObject({ kind: "sync", label: "hi" });
    expect(statements[1]).toMatchObject({ kind: "response", label: "bye" });
  });

  it("captures message endpoints and empty labels", () => {
    const { ast } = parse("participant A\nparticipant B\nA -> B");
    const statement = (ast as unknown as SequenceDiagram).statements[0];
    expect(statement).toMatchObject({ from: "A", to: "B", label: "" });
  });

  it("keeps a long label intact", () => {
    const longLabel = "x".repeat(200);
    const { ast } = parse(`participant A\nparticipant B\nA -> B: ${longLabel}`);
    const statement = (ast as unknown as SequenceDiagram).statements[0];
    expect(statement.label).toBe(longLabel);
  });

  it("skips blank lines without error", () => {
    const { ast, diagnostics } = parse(
      "\n\nparticipant A\n\nparticipant B\n\nA -> B: hi\n\n",
    );
    expect(diagnostics).toEqual([]);
    expect((ast as unknown as SequenceDiagram).participants).toHaveLength(2);
  });

  it("treats a quoted participant label as unsupported in Phase 1", () => {
    // Quoted labels / aliases are a later DSL phase; here the stray string is
    // surfaced as an unexpected token rather than parsed silently.
    const { diagnostics } = parse('participant api "Authentication API"');
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.UnsupportedSyntax),
    ).toBe(true);
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
      diagnostics.some((d) => d.code === DiagnosticCode.MalformedMessage),
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
      participant: "User",
      text: "secret",
    });
  });

  it("parses a right note anchored to a participant", () => {
    const { ast } = parse("note right of API : hi");
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.notes[0]).toMatchObject({
      placement: "right",
      participant: "API",
      text: "hi",
    });
  });

  it("parses an over note anchored to a participant", () => {
    const { ast } = parse("note over User : span");
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.notes[0]).toMatchObject({
      placement: "over",
      participant: "User",
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
    expect(diagram.notes[0].participant).toBeUndefined();
  });

  it("accepts a bare id for left/right without 'of'", () => {
    const { ast } = parse("note left User : bare");
    const diagram = ast as unknown as SequenceDiagram;
    expect(diagram.notes[0]).toMatchObject({
      placement: "left",
      participant: "User",
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
