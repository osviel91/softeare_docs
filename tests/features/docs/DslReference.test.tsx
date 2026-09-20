import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import DslReference, {
  DSL_CONSTRUCTS,
  EVENT_FLOW_CONSTRUCTS,
} from "../../../src/features/docs/DslReference";
import { lex, TokenType } from "../../../src/language/lexer/lexer";
import {
  analyzeEventFlow,
  EventFlowDiagnosticCode,
} from "../../../src/language/eventflow/parser";

/** The event-flow codes that mean "this is not the language's syntax". */
const SYNTAX_CODES = new Set<string>([
  EventFlowDiagnosticCode.UnsupportedSyntax,
  EventFlowDiagnosticCode.MalformedDeclaration,
  EventFlowDiagnosticCode.MalformedMetadata,
  EventFlowDiagnosticCode.UnclosedMetadata,
]);

describe("DslReference", () => {
  it("renders a section for every documented construct", () => {
    render(<DslReference />);
    expect(screen.getByTestId("dsl-reference")).toBeInTheDocument();
    expect(screen.getAllByTestId("docs-syntax")).toHaveLength(
      DSL_CONSTRUCTS.length + EVENT_FLOW_CONSTRUCTS.length,
    );
    expect(screen.getByText("Activation")).toBeInTheDocument();
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByText("Alias")).toBeInTheDocument();
  });

  it("separates the two documentation languages", () => {
    render(<DslReference />);
    expect(screen.getByTestId("docs-section-sequence")).toHaveTextContent(
      "Sequence diagrams",
    );
    expect(screen.getByTestId("docs-section-event-flow")).toHaveTextContent(
      "Event flows",
    );
    // Each section documents its own language, not both.
    expect(screen.getByTestId("docs-section-event-flow")).toHaveTextContent(
      "Publication",
    );
    expect(screen.getByTestId("docs-section-event-flow")).not.toHaveTextContent(
      "Activation",
    );
  });

  it("shows an example for each construct", () => {
    const { container } = render(<DslReference />);
    expect(container.querySelectorAll(".docs__example")).toHaveLength(
      DSL_CONSTRUCTS.length + EVENT_FLOW_CONSTRUCTS.length,
    );
  });

  /**
   * The references are hand-written, so guard them against drifting behind the
   * grammars: every keyword the docs promise must actually lex as a keyword.
   */
  it("documents only keywords the sequence lexer actually knows", () => {
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

  it("documents only syntax the event-flow parser actually accepts", () => {
    for (const construct of EVENT_FLOW_CONSTRUCTS) {
      const syntaxErrors = analyzeEventFlow(construct.example)
        .diagnostics.filter((diagnostic) => SYNTAX_CODES.has(diagnostic.code))
        .map((diagnostic) => diagnostic.message);
      expect(
        syntaxErrors,
        `"${construct.name}" documents syntax the event-flow parser rejects`,
      ).toEqual([]);
    }
  });

  it("gives every construct a name, syntax, summary, and example", () => {
    for (const construct of [...DSL_CONSTRUCTS, ...EVENT_FLOW_CONSTRUCTS]) {
      expect(construct.name.length).toBeGreaterThan(0);
      expect(construct.syntax.length).toBeGreaterThan(0);
      expect(construct.summary.length).toBeGreaterThan(0);
      expect(construct.example.length).toBeGreaterThan(0);
    }
  });
});
