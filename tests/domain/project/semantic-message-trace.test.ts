import { describe, expect, it } from "vitest";
import { semanticMessageCandidates, traceSemanticMessage } from "../../../src/domain/project/semantic-message-trace";
import type { ProjectIndex } from "../../../src/domain/project/project-index";

const range = { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } };
const index = {
  projectId: "p", resources: [], diagrams: [], eventFlows: [], documents: [], participants: [], usages: [], references: [], diagnostics: [],
  semanticMessages: [{ id: "msg-1", name: "RenamedCreated", kind: "event" }],
  semanticOccurrences: [{ resourceId: "seq", name: "Created", kind: "event", operation: "publish", from: "A", to: "B", step: 1, range, messageRef: "msg-1" }],
  eventFlowMessages: [{ resourceId: "flow", name: "Created", kind: "event", messageRef: "msg-1" }],
} satisfies ProjectIndex;

describe("semantic message trace", () => {
  it("does not turn equal names into authoritative bindings", () => {
    const unbound = { ...index, semanticOccurrences: index.semanticOccurrences.map((entry) => ({ ...entry, messageRef: undefined })), eventFlowMessages: index.eventFlowMessages.map((entry) => ({ ...entry, messageRef: undefined })) };
    expect(semanticMessageCandidates(unbound)[0].authoritative).toBe(false);
    expect(semanticMessageCandidates(index)[0].authoritative).toBe(true);
  });

  it("returns only explicit bindings", () => {
    expect(traceSemanticMessage(index, "msg-1").occurrences).toHaveLength(1);
    expect(traceSemanticMessage(index, "msg-1").eventFlowEntities).toHaveLength(1);
  });
});
