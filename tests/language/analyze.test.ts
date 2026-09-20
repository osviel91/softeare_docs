import { describe, expect, it } from "vitest";
import type { SequenceDiagram } from "../../src/domain/diagram/ast";
import { formatDiagnostic } from "../../src/language/diagnostics/diagnostics";
import { analyze } from "../../src/language/analyze";

describe("analyze (end-to-end)", () => {
  it("returns a clean AST with no diagnostics for valid input", () => {
    const result = analyze(
      "title Login\n\nparticipant User\nparticipant API\nUser -> API: login",
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ast).not.toBeNull();
    const diagram = result.ast as unknown as SequenceDiagram;
    expect(diagram.title?.value).toBe("Login");
    expect(diagram.statements).toHaveLength(1);
  });

  it("merges syntax and semantic diagnostics", () => {
    // Syntax error (no arrow) plus an unknown participant.
    const result = analyze("participant A\nA B: hi\nX -> A: unknown sender");
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("seq.malformed-message");
    expect(codes).toContain("seq.unknown-participant");
  });

  it("keeps the editor usable by never throwing on bad input", () => {
    const inputs = ["", "\n", "!!!", "participant\nA -> ", "A --> ", "title"];
    for (const input of inputs) {
      expect(() => analyze(input)).not.toThrow();
    }
  });

  it("formats diagnostics with one-based line and column", () => {
    // Third line, some column.
    const result = analyze("participant A\nparticipant B\n@@ bad");
    expect(result.diagnostics.length).toBeGreaterThan(0);
    const formatted = formatDiagnostic(result.diagnostics[0]);
    expect(formatted).toContain("Line 3");
  });

  it("accepts a valid alias end-to-end", () => {
    const result = analyze("participant User\nalias U = User\nU -> User: hi");
    expect(result.diagnostics).toEqual([]);
    const diagram = result.ast as unknown as SequenceDiagram;
    expect(diagram.aliases).toHaveLength(1);
  });

  it("surfaces an unknown alias target through analyze", () => {
    const result = analyze("alias U = Ghost");
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "seq.unknown-alias-target",
    );
  });

  it("parses a valid note end-to-end with no diagnostics", () => {
    const result = analyze(
      "participant User\nparticipant API\nnote left of User : secret",
    );
    expect(result.diagnostics).toEqual([]);
    const diagram = result.ast as unknown as SequenceDiagram;
    expect(diagram.notes).toHaveLength(1);
    expect(diagram.notes[0]).toMatchObject({
      placement: "left",
      participant: "User",
      text: "secret",
    });
  });

  it("collects multiple notes in source order through analyze", () => {
    const result = analyze(
      "note left of User : a\nnote over : shared\nnote right of API : b",
    );
    const diagram = result.ast as unknown as SequenceDiagram;
    expect(diagram.notes.map((n) => n.text)).toEqual(["a", "shared", "b"]);
  });

  it("surfaces a malformed note (missing terminator) through analyze", () => {
    const result = analyze("note left of User");
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "seq.malformed-note",
    );
  });

  it("keeps the editor usable on a malformed note line", () => {
    expect(() => analyze("note")).not.toThrow();
  });
});
