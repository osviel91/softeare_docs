import { describe, expect, it } from "vitest";
import { participantSegments } from "../../../src/features/editor/participant-highlight";
import {
  collectParticipantMentions,
  type ParticipantMention,
} from "../../../src/domain/diagram/participant-mentions";
import { analyze } from "../../../src/language/analyze";

describe("participantSegments", () => {
  it("marks participant names and leaves the rest as plain text", () => {
    const source = "participant API\nAPI -> DB: hi\n";
    const { ast } = analyze(source);
    const segments = participantSegments(
      source,
      collectParticipantMentions(ast!, source),
    );
    expect(segments).toEqual([
      { text: "participant ", participant: false },
      { text: "API", participant: true },
      { text: "\n", participant: false },
      { text: "API", participant: true },
      { text: " -> ", participant: false },
      { text: "DB", participant: true },
      { text: ": hi\n", participant: false },
    ]);
  });

  it("reproduces the source exactly when concatenated", () => {
    const source = "participant API\nAPI -> DB: hi\n";
    const { ast } = analyze(source);
    const segments = participantSegments(
      source,
      collectParticipantMentions(ast!, source),
    );
    expect(segments.map((segment) => segment.text).join("")).toBe(source);
  });

  it("returns nothing for an empty document", () => {
    expect(participantSegments("", [])).toEqual([]);
  });

  it("merges mentions that overlap and drops ones outside the text", () => {
    const mentions: ParticipantMention[] = [
      {
        name: "AB",
        context: "message",
        range: {
          start: { line: 0, column: 0 },
          end: { line: 0, column: 2 },
        },
      },
      {
        name: "BC",
        context: "message",
        range: {
          start: { line: 0, column: 1 },
          end: { line: 0, column: 3 },
        },
      },
      {
        name: "Gone",
        context: "message",
        range: {
          start: { line: 9, column: 0 },
          end: { line: 9, column: 4 },
        },
      },
    ];
    expect(participantSegments("ABCD", mentions)).toEqual([
      { text: "ABC", participant: true },
      { text: "D", participant: false },
    ]);
  });
});
