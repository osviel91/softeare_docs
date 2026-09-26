import { describe, expect, it } from "vitest";
import { semanticComparison } from "../../../src/features/preview/semantic-comparison";
import type { ProjectIndex } from "../../../src/domain/project/project-index";

function index(overrides: Partial<ProjectIndex> = {}): ProjectIndex {
  return {
    projectId: "p",
    resources: [],
    diagrams: [],
    eventFlows: [],
    documents: [],
    participants: [],
    usages: [],
    references: [],
    diagnostics: [],
    semanticMessages: [],
    semanticOccurrences: [],
    eventFlowMessages: [],
    ...overrides,
  };
}

describe("semanticComparison", () => {
  it("matches authoritative sequence and Event Flow occurrences by identity", () => {
    const result = semanticComparison(index({
      semanticMessages: [{ id: "created", name: "Created", kind: "event" }],
      semanticOccurrences: [{ resourceId: "seq", name: "Created", kind: "event", operation: "publish", step: 1, from: "A", to: "B", messageRef: "created", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }],
      eventFlowMessages: [{ resourceId: "flow", name: "Created", kind: "event", messageRef: "created", nodeId: "event:1", sourceRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }],
    }), "seq", "flow");
    expect(result.shared.map((entry) => entry.id)).toEqual(["created"]);
    expect(result.occurrences.a[0].operation).toBe("publish");
    expect(result.occurrences.b[0].nodeId).toBe("event:1");
  });

  it("does not match equal names with different identities and preserves candidates", () => {
    const result = semanticComparison(index({
      semanticMessages: [
        { id: "a", name: "Changed", kind: "event" },
        { id: "b", name: "Changed", kind: "event" },
      ],
      semanticOccurrences: [
        { resourceId: "a", name: "Changed", kind: "event", operation: "publish", step: 1, from: "A", to: "B", messageRef: "a", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
        { resourceId: "b", name: "Changed", kind: "event", operation: "consume", step: 1, from: "B", to: "C", messageRef: "b", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
        { resourceId: "b", name: "Changed", kind: "event", operation: "consume", step: 2, from: "B", to: "D", range: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } } },
      ],
    }), "a", "b");
    expect(result.shared).toHaveLength(0);
    expect(result.onlyA.map((entry) => entry.id)).toEqual(["a"]);
    expect(result.onlyB.map((entry) => entry.id)).toEqual(["b"]);
    expect(result.candidates).toHaveLength(1);
  });

  it("keeps complementary relationships separate from semantic matches", () => {
    const result = semanticComparison(index({
      semanticMessages: [{ id: "m", name: "M", kind: "command" }],
      semanticOccurrences: [{ resourceId: "a", name: "M", kind: "command", operation: "dispatch", step: 1, from: "A", to: "B", messageRef: "m", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }],
    }), "a", "b", [{ kind: "complementary-view", sourceId: "a", targetId: "b", sourceRole: "execution", targetRole: "causal" }]);
    expect(result.onlyA[0].kind).toBe("command");
    expect(result.relationship?.sourceRole).toBe("execution");
  });
});
