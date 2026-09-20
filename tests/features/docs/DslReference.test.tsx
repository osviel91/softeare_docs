import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import DslReference, {
  DSL_CONSTRUCTS,
} from "../../../src/features/docs/DslReference";
import { lex, TokenType } from "../../../src/language/lexer/lexer";

describe("DslReference", () => {
  it("renders a section for every documented construct", () => {
    render(<DslReference />);
    expect(screen.getByTestId("dsl-reference")).toBeInTheDocument();
    expect(screen.getAllByTestId("docs-syntax")).toHaveLength(
      DSL_CONSTRUCTS.length,
    );
    expect(screen.getByText("Activation")).toBeInTheDocument();
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByText("Alias")).toBeInTheDocument();
  });

  it("shows an example for each construct", () => {
    const { container } = render(<DslReference />);
    expect(container.querySelectorAll(".docs__example")).toHaveLength(
      DSL_CONSTRUCTS.length,
    );
  });

  /**
   * The reference is hand-written, so guard it against drifting behind the
   * grammar: every keyword the docs promise must actually lex as a keyword.
   */
  it("documents only keywords the lexer actually knows", () => {
    const keywordTokens: Partial<Record<string, TokenType>> = {
      title: TokenType.Title,
      participant: TokenType.Participant,
      actor: TokenType.Actor,
      alias: TokenType.Alias,
      note: TokenType.Note,
      activate: TokenType.Activate,
      deactivate: TokenType.Deactivate,
      loop: TokenType.Loop,
      alt: TokenType.Alt,
      else: TokenType.Else,
      opt: TokenType.Opt,
      par: TokenType.Par,
      and: TokenType.And,
      critical: TokenType.Critical,
      option: TokenType.Option,
      break: TokenType.Break,
      end: TokenType.End,
    };

    for (const construct of DSL_CONSTRUCTS) {
      for (const [keyword, tokenType] of Object.entries(keywordTokens)) {
        if (!new RegExp(`\\b${keyword}\\b`).test(construct.syntax)) continue;
        const tokens = lex(`${keyword} X`).tokens;
        expect(
          tokens[0].type,
          `"${keyword}" is documented but is not a lexer keyword`,
        ).toBe(tokenType);
      }
    }
  });

  it("gives every construct a name, syntax, summary, and example", () => {
    for (const construct of DSL_CONSTRUCTS) {
      expect(construct.name.length).toBeGreaterThan(0);
      expect(construct.syntax.length).toBeGreaterThan(0);
      expect(construct.summary.length).toBeGreaterThan(0);
      expect(construct.example.length).toBeGreaterThan(0);
    }
  });
});
