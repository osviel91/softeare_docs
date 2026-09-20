import { describe, expect, it } from "vitest";
import { applyLiveRename } from "../../../src/features/editor/live-rename";
import {
  collectParticipantMentions,
  type ParticipantMention,
} from "../../../src/domain/diagram/participant-mentions";
import { analyze } from "../../../src/language/analyze";

/** The mentions a parse of `source` produces. */
function mentionsOf(source: string): ParticipantMention[] {
  const { ast } = analyze(source);
  return ast ? collectParticipantMentions(ast, source) : [];
}

describe("applyLiveRename", () => {
  it("rewrites every usage when a declaration's name is retyped", () => {
    const previous = [
      "title T",
      "participant API",
      "",
      "API -> DB: hi",
      "",
    ].join("\n");
    const next = previous.replace("participant API", "participant SVC");
    const caret = next.indexOf("participant SVC") + "participant SVC".length;

    const result = applyLiveRename({
      previous,
      next,
      caret,
      mentions: mentionsOf(previous),
    });

    expect(result.renamed).toBe(true);
    expect(result.source).toBe(
      ["title T", "participant SVC", "", "SVC -> DB: hi", ""].join("\n"),
    );
    expect(result.caret).toBe(caret);
  });

  it("rewrites a note anchor and an alias target too", () => {
    const previous = [
      "participant API",
      "alias A = API",
      "API -> API: work",
      "note over API: busy",
      "",
    ].join("\n");
    const next = previous.replace("participant API", "participant Service");
    const caret =
      next.indexOf("participant Service") + "participant Service".length;

    const result = applyLiveRename({
      previous,
      next,
      caret,
      mentions: mentionsOf(previous),
    });

    expect(result.source).toBe(
      [
        "participant Service",
        "alias A = Service",
        "Service -> Service: work",
        "note over Service: busy",
        "",
      ].join("\n"),
    );
  });

  it("does not rename when a message endpoint is edited", () => {
    const previous = "participant API\nAPI -> DB: hi\n";
    const next = "participant API\nSVC -> DB: hi\n";
    const caret = next.indexOf("SVC") + 3;

    const result = applyLiveRename({
      previous,
      next,
      caret,
      mentions: mentionsOf(previous),
    });

    expect(result.renamed).toBe(false);
    expect(result.source).toBe(next);
  });

  it("does not rename when prose in a label is edited", () => {
    const previous = "participant API\nAPI -> DB: hi\n";
    const next = "participant API\nAPI -> DB: API is busy\n";

    const result = applyLiveRename({
      previous,
      next,
      caret: next.length,
      mentions: mentionsOf(previous),
    });

    expect(result.renamed).toBe(false);
    expect(result.source).toBe(next);
  });

  it("refuses a rename that would merge two lifelines", () => {
    const previous = "participant API\nparticipant DB\nAPI -> DB: hi\n";
    const next = previous.replace("participant API", "participant DB");
    const caret = next.indexOf("participant DB") + "participant DB".length;

    const result = applyLiveRename({
      previous,
      next,
      caret,
      mentions: mentionsOf(previous),
    });

    expect(result.renamed).toBe(false);
  });

  it("does nothing while the identifier is empty", () => {
    const previous = "participant API\nAPI -> DB: hi\n";
    const next = "participant \nAPI -> DB: hi\n";

    const result = applyLiveRename({
      previous,
      next,
      caret: "participant ".length,
      mentions: mentionsOf(previous),
    });

    expect(result.renamed).toBe(false);
    expect(result.source).toBe(next);
  });

  it("shifts the caret when a rewritten usage precedes it", () => {
    const previous = "API -> DB: hi\nparticipant API\n";
    const next = "API -> DB: hi\nparticipant SVCAPI\n";
    const mentions: ParticipantMention[] = [
      {
        name: "API",
        context: "message",
        range: {
          start: { line: 0, column: 0 },
          end: { line: 0, column: 3 },
        },
      },
      {
        name: "API",
        context: "declaration",
        range: {
          start: { line: 1, column: 12 },
          end: { line: 1, column: 15 },
        },
      },
    ];
    const caret = next.length;

    const result = applyLiveRename({ previous, next, caret, mentions });

    expect(result.source).toBe("SVCAPI -> DB: hi\nparticipant SVCAPI\n");
    expect(result.caret).toBe(caret + "SVCAPI".length - "API".length);
  });

  it("leaves the text alone when there are no mentions", () => {
    const previous = "event OrderCreated\n";
    const next = "event OrderCreatedX\n";
    const result = applyLiveRename({
      previous,
      next,
      caret: next.length,
      mentions: [],
    });
    expect(result).toEqual({
      source: next,
      caret: next.length,
      renamed: false,
    });
  });
});
