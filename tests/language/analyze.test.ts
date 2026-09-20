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
      participants: ["User"],
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

describe("analyze — Mermaid-parity constructs end to end", () => {
  const PARITY = `title Mermaid parity

actor User
participant API
participant DB as "User Database"
participant Queue

User ->>+ API: Login
API -> DB: Cache miss
API -x DB: Dropped
API -) Queue: Publish
API <<->> API: Sync
activate API
API ->> API: Work
deactivate API
API -->>- User: Token
loop retry up to 3 times
  API ->> DB: Query
end
alt found
  DB -->> API: Row
else missing
  API -->> User: 404
end
par left
  API ->> DB: L
and right
  API ->> DB: R
end
critical commit
  API ->> DB: Commit
option rollback
  API ->> DB: Rollback
end
opt cached
  API -->> User: Cached
end
break rejected
  API -->> User: 400
end
note over API,DB : Transaction boundary
note right of API:
  Validate JWT
  Check expiration
end note
`;

  it("parses and validates without a single diagnostic", () => {
    const result = analyze(PARITY);
    expect(result.diagnostics).toEqual([]);
    expect(result.ast).not.toBeNull();
  });

  it("keeps every fragment explicitly in the AST", () => {
    const result = analyze(PARITY);
    const diagram = result.ast as unknown as SequenceDiagram;
    const kinds = diagram.statements
      .filter((s) => !["message", "activation"].includes(s.type))
      .map((s) => s.type);
    expect(kinds).toEqual(["loop", "alt", "par", "critical", "opt", "break"]);
  });

  it("captures the actor, the labelled id, and the spanning/multiline notes", () => {
    const result = analyze(PARITY);
    const diagram = result.ast as unknown as SequenceDiagram;
    expect(diagram.participants[0]).toMatchObject({
      id: "User",
      participantType: "actor",
    });
    expect(diagram.participants[2]).toMatchObject({
      id: "DB",
      label: "User Database",
    });
    expect(diagram.notes[0]).toMatchObject({
      placement: "over",
      participants: ["API", "DB"],
    });
    expect(diagram.notes[1]?.text).toBe("Validate JWT\nCheck expiration");
  });
});
