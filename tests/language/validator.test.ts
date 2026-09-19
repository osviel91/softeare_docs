import { describe, expect, it } from "vitest";
import type { SequenceDiagram } from "../../src/domain/diagram/ast";
import { DiagnosticCode } from "../../src/language/diagnostics/diagnostics";
import { parse } from "../../src/language/parser/parser";
import { validateSemantics } from "../../src/language/validator/validator";

const diagramOf = (source: string): SequenceDiagram =>
  parse(source).ast as unknown as SequenceDiagram;

describe("validateSemantics", () => {
  it("passes a well-formed diagram", () => {
    const diagram = diagramOf(
      "participant A\nparticipant B\nA -> B: hi\nB --> A: bye",
    );
    expect(validateSemantics(diagram)).toEqual([]);
  });

  it("flags a message with an unknown sender", () => {
    const diagram = diagramOf("participant B\nGhost -> B: hi");
    const diagnostics = validateSemantics(diagram);
    expect(
      diagnostics.some(
        (d) =>
          d.code === DiagnosticCode.UnknownParticipant &&
          d.message.includes("Ghost"),
      ),
    ).toBe(true);
  });

  it("flags a message with an unknown receiver", () => {
    const diagram = diagramOf("participant A\nA -> Nobody: hi");
    const diagnostics = validateSemantics(diagram);
    expect(
      diagnostics.some(
        (d) =>
          d.code === DiagnosticCode.UnknownParticipant &&
          d.message.includes("Nobody"),
      ),
    ).toBe(true);
  });

  it("flags duplicate participant declarations", () => {
    const diagram = diagramOf("participant A\nparticipant A\nA -> A: self");
    const diagnostics = validateSemantics(diagram);
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.DuplicateParticipant),
    ).toBe(true);
  });

  it("flags each unknown endpoint of a message", () => {
    const diagram = diagramOf("X -> Y: hi");
    // No participants declared at all.
    const diagnostics = validateSemantics(diagram);
    const unknownEndpoints = diagnostics.filter(
      (d) => d.code === DiagnosticCode.UnknownParticipant,
    );
    expect(unknownEndpoints).toHaveLength(2);
  });

  it("does not flag self-messages between declared participants", () => {
    const diagram = diagramOf("participant A\nA -> A: tick");
    expect(validateSemantics(diagram)).toEqual([]);
  });
});
