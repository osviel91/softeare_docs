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
