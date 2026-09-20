import { describe, expect, it } from "vitest";
import type {
  SequenceDiagram,
  SourceRange,
  Statement,
} from "../../../src/domain/diagram/ast";
import { walkStatements } from "../../../src/domain/diagram/ast";
import {
  nodeIdAtOffset,
  nodeIdAtPosition,
  nodeIdOf,
  nodeRangeById,
  type AstNodeKind,
} from "../../../src/domain/diagram/node-id";
import { parse } from "../../../src/language/parser/parser";

/** Every kind the id scheme knows about, for the prefix assertion. */
const KINDS: AstNodeKind[] = [
  "title",
  "participant",
  "alias",
  "message",
  "activation",
  "note",
  "loop",
  "alt",
  "opt",
  "par",
  "critical",
  "break",
  "branch",
];

/** Parse a fixture, failing loudly if the fixture itself is malformed. */
function parseDiagram(source: string): SequenceDiagram {
  const { ast } = parse(source);
  if (ast === null) throw new Error("fixture failed to parse");
  return ast;
}

/** A node kind paired with the range it was found at. */
interface FoundNode {
  kind: AstNodeKind;
  range: SourceRange;
}

/**
 * Enumerate every addressable node independently of the module under test, so
 * the inverse-lookup assertion does not just re-run the production walker.
 */
function collectNodes(diagram: SequenceDiagram): FoundNode[] {
  const nodes: FoundNode[] = [];
  if (diagram.title) nodes.push({ kind: "title", range: diagram.title.range });
  for (const participant of diagram.participants) {
    nodes.push({ kind: "participant", range: participant.range });
  }
  for (const alias of diagram.aliases) {
    nodes.push({ kind: "alias", range: alias.range });
  }
  for (const statement of walkStatements(diagram.statements)) {
    nodes.push(...statementNodes(statement));
  }
  for (const note of diagram.notes) {
    nodes.push({ kind: "note", range: note.range });
  }
  return nodes;
}

/** The node a single statement contributes (plus its branches, if any). */
function statementNodes(statement: Statement): FoundNode[] {
  switch (statement.type) {
    case "message":
      return [{ kind: "message", range: statement.range }];
    case "activation":
      return [{ kind: "activation", range: statement.range }];
    case "loop":
    case "opt":
    case "break":
      return [{ kind: statement.type, range: statement.range }];
    case "alt":
    case "par":
    case "critical":
      return [
        { kind: statement.type, range: statement.range },
        ...statement.branches.map((branch) => ({
          kind: "branch" as const,
          range: branch.range,
        })),
      ];
  }
}

/** A fixture that exercises every addressable node kind at least once. */
const FULL_SOURCE = `title Login
participant User
participant API
alias U = User
activate API
deactivate API
note over API: cached
loop retry
  User -> API: ping
end
alt ok
  User -> API: yes
else bad
  API --> User: no
end
opt maybe
  User -> API: opt
end
par left
  User -> API: l
and right
  API --> User: r
end
critical safe
  User -> API: c
option risky
  API --> User: x
end
break abort
  API --> User: stop
end
`;

describe("nodeIdOf", () => {
  it("formats a kind and the range's start as <kind>@<line>:<column>", () => {
    expect(
      nodeIdOf("message", {
        start: { line: 3, column: 4 },
        end: { line: 3, column: 12 },
      }),
    ).toBe("message@3:4");
  });

  it("gives every node kind its own prefix", () => {
    const span: SourceRange = {
      start: { line: 1, column: 2 },
      end: { line: 1, column: 3 },
    };
    for (const kind of KINDS) {
      expect(nodeIdOf(kind, span)).toBe(`${kind}@1:2`);
    }
  });
});

describe("nodeIdAtPosition", () => {
  const ast = parseDiagram(FULL_SOURCE);

  it("finds the participant declaration under a position on its line", () => {
    expect(nodeIdAtPosition(ast, { line: 1, column: 3 })).toBe(
      "participant@1:0",
    );
  });

  it("finds the title under a position on the title line", () => {
    expect(nodeIdAtPosition(ast, { line: 0, column: 3 })).toBe("title@0:0");
  });

  it("finds the alias under a position on its line", () => {
    expect(nodeIdAtPosition(ast, { line: 3, column: 3 })).toBe("alias@3:0");
  });

  it("finds the activation under a position on its statement", () => {
    expect(nodeIdAtPosition(ast, { line: 4, column: 3 })).toBe(
      "activation@4:0",
    );
  });

  it("finds the note under a position inside its text", () => {
    expect(nodeIdAtPosition(ast, { line: 6, column: 12 })).toBe("note@6:0");
  });

  it("prefers the deepest message over the loop that encloses it", () => {
    // Line 8 is "  User -> API: ping"; column 16 is inside the label.
    expect(nodeIdAtPosition(ast, { line: 8, column: 16 })).toBe("message@8:2");
  });

  it("resolves a loop header to the loop, not to anything above it", () => {
    expect(nodeIdAtPosition(ast, { line: 7, column: 0 })).toBe("loop@7:0");
  });

  it("prefers a branch over the alt fragment that owns it", () => {
    // Line 12 is the `else` line, which starts the second branch's range.
    expect(nodeIdAtPosition(ast, { line: 12, column: 0 })).toBe("branch@12:0");
  });

  it("resolves a message inside an alt branch to that message", () => {
    // Line 11 is "  User -> API: yes"; column 17 is inside the label.
    expect(nodeIdAtPosition(ast, { line: 11, column: 17 })).toBe(
      "message@11:2",
    );
  });

  it("resolves a position only the frame covers to the frame", () => {
    // The `end` line is inside the alt's range but past its last branch.
    expect(nodeIdAtPosition(ast, { line: 14, column: 0 })).toBe("alt@10:0");
  });

  it("resolves the other fragment kinds and branch dividers", () => {
    expect(nodeIdAtPosition(ast, { line: 15, column: 0 })).toBe("opt@15:0");
    expect(nodeIdAtPosition(ast, { line: 20, column: 0 })).toBe("branch@20:0");
    expect(nodeIdAtPosition(ast, { line: 25, column: 0 })).toBe("branch@25:0");
    expect(nodeIdAtPosition(ast, { line: 28, column: 0 })).toBe("break@28:0");
  });

  it("returns null for a position in blank space", () => {
    const blank = parseDiagram("participant A\nparticipant B\n\nA -> B: hi\n");
    expect(nodeIdAtPosition(blank, { line: 2, column: 0 })).toBeNull();
  });

  it("returns null past the last statement", () => {
    expect(nodeIdAtPosition(ast, { line: 99, column: 0 })).toBeNull();
  });
});

describe("nodeIdAtOffset", () => {
  it("agrees with the position lookup", () => {
    const source = "participant A\nA -> A: hello\n";
    const ast = parseDiagram(source);
    const offset = source.indexOf("hello") + 2;
    expect(nodeIdAtOffset(source, ast, offset)).toBe("message@1:0");
  });

  it("clamps an offset outside the document instead of throwing", () => {
    const source = "participant A\nA -> A: hello\n";
    const ast = parseDiagram(source);
    expect(nodeIdAtOffset(source, ast, -10)).toBe("participant@0:0");
    expect(nodeIdAtOffset(source, ast, 10_000)).toBeNull();
  });

  it("resolves offsets in CRLF text the way the AST sees them", () => {
    const source = "participant A\r\nA -> A: hello\r\n";
    const ast = parseDiagram(source);
    const offset = source.indexOf("hello") + 1;
    expect(nodeIdAtOffset(source, ast, offset)).toBe("message@1:0");
  });
});

describe("nodeRangeById", () => {
  it("inverts nodeIdOf for every addressable node", () => {
    const ast = parseDiagram(FULL_SOURCE);
    const nodes = collectNodes(ast);
    // Guard the assertion below: a broken fixture that enumerated nothing
    // would otherwise pass vacuously.
    expect(nodes.length).toBeGreaterThan(10);
    for (const node of nodes) {
      const id = nodeIdOf(node.kind, node.range);
      expect(nodeRangeById(ast, id)).toEqual(node.range);
    }
  });

  it("returns null for an id that names no node", () => {
    const ast = parseDiagram(FULL_SOURCE);
    expect(nodeRangeById(ast, "message@999:999")).toBeNull();
    expect(nodeRangeById(ast, "not-an-id")).toBeNull();
  });
});

describe("determinism", () => {
  it("produces identical ids for two parses of the same source", () => {
    const first = collectNodes(parseDiagram(FULL_SOURCE)).map((node) =>
      nodeIdOf(node.kind, node.range),
    );
    const second = collectNodes(parseDiagram(FULL_SOURCE)).map((node) =>
      nodeIdOf(node.kind, node.range),
    );
    expect(first).toEqual(second);
    // Every id is distinct: a collision would make the inverse lookup
    // ambiguous even though the forward parse were stable.
    expect(new Set(first).size).toBe(first.length);
  });

  it("resolves every node from a position at its own start when it is the deepest", () => {
    // A message start is unambiguous, so a forward lookup must name the same
    // node the inverse lookup resolves from its id.
    const ast = parseDiagram(FULL_SOURCE);
    const id = nodeIdAtPosition(ast, { line: 8, column: 2 });
    expect(id).toBe("message@8:2");
    expect(nodeRangeById(ast, id as string)?.start).toEqual({
      line: 8,
      column: 2,
    });
  });
});
