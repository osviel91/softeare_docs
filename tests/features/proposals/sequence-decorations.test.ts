import { describe, expect, it } from "vitest";
import { diffResources } from "../../../src/domain/diff/resource-diff";
import type { ResourceState } from "../../../src/domain/diff/resource-state";
import { sequenceDiffDecorations } from "../../../src/features/proposals/sequence-decorations";

const state = (content: string): ResourceState => ({
  content,
  type: "sequence-diagram",
});

function decorations(base: string, proposed: string) {
  const changes = diffResources(state(base), state(proposed)).content.changes;
  return sequenceDiffDecorations(changes);
}

const participants = "participant A\nparticipant B\nparticipant C\n";

describe("sequence diff decorations", () => {
  it("classifies a text change as a modified interaction with messageChanged", () => {
    const [decoration] = decorations(
      `${participants}A -> B: old text`,
      `${participants}A -> B: new text`,
    );
    expect(decoration.kind).toBe("modified-interaction");
    if (decoration.kind !== "modified-interaction") throw new Error("kind");
    expect(decoration.dimensions).toEqual({
      messageChanged: true,
      sourceChanged: false,
      targetChanged: false,
      directionChanged: false,
      interactionKindChanged: false,
    });
  });

  it("classifies a direction swap with directionChanged", () => {
    const [decoration] = decorations(
      `${participants}A -> B: command`,
      `${participants}B -> A: command`,
    );
    if (decoration.kind !== "modified-interaction") throw new Error("kind");
    expect(decoration.dimensions.directionChanged).toBe(true);
    expect(decoration.dimensions.sourceChanged).toBe(true);
    expect(decoration.dimensions.targetChanged).toBe(true);
  });

  it("classifies an endpoint change with targetChanged", () => {
    const [decoration] = decorations(
      `${participants}A -> B: command`,
      `${participants}A -> C: command`,
    );
    if (decoration.kind !== "modified-interaction") throw new Error("kind");
    expect(decoration.dimensions.targetChanged).toBe(true);
    expect(decoration.dimensions.sourceChanged).toBe(false);
  });

  it("classifies a dashed/solid change with interactionKindChanged", () => {
    const [decoration] = decorations(
      `${participants}A -> B: command`,
      `${participants}A --> B: command`,
    );
    if (decoration.kind !== "modified-interaction") throw new Error("kind");
    expect(decoration.dimensions.interactionKindChanged).toBe(true);
  });

  it("classifies added and removed interactions", () => {
    const added = decorations(
      `${participants}A -> B: one`,
      `${participants}A -> B: one\nA -> B: two`,
    );
    expect(added).toEqual([
      expect.objectContaining({ kind: "added-interaction", number: 2 }),
    ]);
    const removed = decorations(
      `${participants}A -> B: one\nA -> B: two`,
      `${participants}A -> B: one`,
    );
    expect(removed).toEqual([
      expect.objectContaining({ kind: "removed-interaction", number: 2 }),
    ]);
  });

  it("classifies added and removed participants", () => {
    expect(
      decorations("participant A\nA -> A: x", "participant A\nparticipant B\nA -> A: x"),
    ).toEqual([
      expect.objectContaining({
        kind: "added-participant",
        participantId: "B",
      }),
    ]);
    expect(
      decorations("participant A\nparticipant B\nA -> A: x", "participant A\nA -> A: x"),
    ).toEqual([
      expect.objectContaining({
        kind: "removed-participant",
        participantId: "B",
      }),
    ]);
  });
});
