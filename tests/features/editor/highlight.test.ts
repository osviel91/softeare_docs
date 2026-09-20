import { describe, expect, it } from "vitest";
import { highlightSegments } from "../../../src/features/editor/highlight";
import type { SourceMention } from "../../../src/domain/source-mention";
import { collectParticipantMentions } from "../../../src/domain/diagram/participant-mentions";
import { analyze } from "../../../src/language/analyze";

describe("highlightSegments", () => {
  it("marks participant names and leaves the rest as plain text", () => {
    const source = "participant API\nAPI -> DB: hi\n";
    const { ast } = analyze(source);
    const segments = highlightSegments(
      source,
      collectParticipantMentions(ast!, source),
    );
    expect(segments).toEqual([
      { text: "participant ", highlighted: false },
      { text: "API", highlighted: true },
      { text: "\n", highlighted: false },
      { text: "API", highlighted: true },
      { text: " -> ", highlighted: false },
      { text: "DB", highlighted: true },
      { text: ": hi\n", highlighted: false },
    ]);
  });

  it("reproduces the source exactly when concatenated", () => {
    const source = "participant API\nAPI -> DB: hi\n";
    const { ast } = analyze(source);
    const segments = highlightSegments(
      source,
      collectParticipantMentions(ast!, source),
    );
    expect(segments.map((segment) => segment.text).join("")).toBe(source);
  });

  it("returns nothing for an empty document", () => {
    expect(highlightSegments("", [])).toEqual([]);
  });

  it("merges mentions that overlap and drops ones outside the text", () => {
    const mentions: SourceMention[] = [
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
    expect(highlightSegments("ABCD", mentions)).toEqual([
      { text: "ABC", highlighted: true },
      { text: "D", highlighted: false },
    ]);
  });
});
