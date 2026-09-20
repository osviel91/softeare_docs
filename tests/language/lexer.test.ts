import { describe, expect, it } from "vitest";
import { lex, TokenType } from "../../src/language/lexer/lexer";

describe("lexer", () => {
  it("tokenizes a title line", () => {
    const { tokens } = lex("title Authentication Flow");
    expect(tokens[0]).toMatchObject({ type: TokenType.Title, value: "title" });
    expect(tokens[1]).toMatchObject({
      type: TokenType.Identifier,
      value: "Authentication",
    });
    expect(tokens[2]).toMatchObject({
      type: TokenType.Identifier,
      value: "Flow",
    });
  });

  it("distinguishes sync and response arrows", () => {
    const content = (tokens: { type: TokenType }[]) =>
      tokens.filter((t) => t.type !== TokenType.Eol).map((t) => t.type);

    expect(content(lex("User -> API").tokens)).toEqual([
      TokenType.Identifier,
      TokenType.SyncArrow,
      TokenType.Identifier,
    ]);

    expect(content(lex("API --> User").tokens)).toEqual([
      TokenType.Identifier,
      TokenType.ResponseArrow,
      TokenType.Identifier,
    ]);
  });

  it("does not confuse '-->' with '-' then '->'", () => {
    const tokens = lex("A --> B").tokens;
    const arrow = tokens.find((t) => t.type === TokenType.ResponseArrow);
    expect(arrow?.value).toBe("-->");
    expect(tokens.some((t) => t.type === TokenType.SyncArrow)).toBe(false);
  });

  it("tokenizes a colon-separated label", () => {
    const tokens = lex("User -> API: Login").tokens;
    expect(
      tokens.some((t) => t.type === TokenType.Colon && t.value === ":"),
    ).toBe(true);
  });

  it("reads a quoted label as a single string token", () => {
    const tokens = lex('participant api as "Authentication API"').tokens;
    const strings = tokens.filter((t) => t.type === TokenType.StringLiteral);
    expect(strings).toHaveLength(1);
    expect(strings[0]?.value).toBe("Authentication API");
  });

  it("treats identifiers with dots and hyphens as one token", () => {
    const tokens = lex("payment-service.v2 -> db").tokens;
    expect(
      tokens.filter((t) => t.type === TokenType.Identifier).map((t) => t.value),
    ).toEqual(["payment-service.v2", "db"]);
  });

  it("skips whitespace and blank lines", () => {
    const { tokens } = lex("  User   ->   API  \n\n   ");
    // No whitespace tokens should ever be emitted.
    expect(tokens.some((t) => t.value === " ")).toBe(false);
    expect(tokens[0]?.type).toBe(TokenType.Identifier);
  });

  it("skips line comments", () => {
    const { tokens } = lex("User -> API: Hello // a comment");
    expect(tokens.every((t) => t.type !== TokenType.Unknown)).toBe(true);
    // The comment text must not leak into tokens.
    expect(tokens.some((t) => t.value === "comment")).toBe(false);
  });

  it("reports an unterminated string literal", () => {
    const { diagnostics } = lex('participant "oops');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("Unterminated string");
  });

  it("assigns zero-based line and column positions", () => {
    const { tokens } = lex("AB\nCD");
    const first = tokens[0];
    expect(first?.start).toEqual({ line: 0, column: 0 });
    // The second line's first token.
    const second = tokens.find((t) => t.value === "CD");
    expect(second?.start).toEqual({ line: 1, column: 0 });
  });

  it("recognizes the alias keyword", () => {
    const tokens = lex("alias U = User").tokens;
    expect(tokens[0]).toMatchObject({ type: TokenType.Alias, value: "alias" });
  });

  it("tokenizes the alias '=' separator", () => {
    const tokens = lex("alias U = User").tokens;
    expect(
      tokens.some((t) => t.type === TokenType.Equals && t.value === "="),
    ).toBe(true);
  });

  it("does not treat 'alias' as a plain identifier", () => {
    const tokens = lex("alias U = User").tokens;
    expect(
      tokens.some(
        (t) => t.type === TokenType.Identifier && t.value === "alias",
      ),
    ).toBe(false);
  });

  it("recognizes the 'note' keyword", () => {
    const tokens = lex("note left of User : hi").tokens;
    expect(tokens[0]).toMatchObject({ type: TokenType.Note, value: "note" });
  });

  it("does not treat 'note' as a plain identifier", () => {
    const tokens = lex("note over User : hi").tokens;
    expect(
      tokens.some((t) => t.type === TokenType.Identifier && t.value === "note"),
    ).toBe(false);
  });

  it("tokenizes a note's placement, target, and colon", () => {
    const tokens = lex("note right of API : secret").tokens;
    const types = tokens
      .filter((t) => t.type !== TokenType.Eol)
      .map((t) => t.type);
    expect(types).toEqual([
      TokenType.Note,
      TokenType.Identifier,
      TokenType.Identifier,
      TokenType.Identifier,
      TokenType.Colon,
      TokenType.Identifier,
    ]);
  });
});

describe("lexer — activations", () => {
  it("tokenizes activate and deactivate as keywords, not identifiers", () => {
    const types = (source: string) =>
      lex(source)
        .tokens.filter((t) => t.type !== TokenType.Eol)
        .map((t) => t.type);

    expect(types("activate User")).toEqual([
      TokenType.Activate,
      TokenType.Identifier,
    ]);
    expect(types("deactivate User")).toEqual([
      TokenType.Deactivate,
      TokenType.Identifier,
    ]);
  });

  it("still lexes a participant merely named like the keywords", () => {
    // Only the bare keyword is reserved; it remains valid as a message arrow
    // operand position identifier elsewhere on a line.
    const tokens = lex("A -> activate").tokens;
    expect(tokens[2]).toMatchObject({
      type: TokenType.Activate,
      value: "activate",
    });
  });
});
