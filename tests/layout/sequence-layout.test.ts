import { describe, expect, it } from "vitest";
import type {
  ActivationNode,
  NoteNode,
  SequenceDiagram,
} from "../../src/domain/diagram/ast";
import {
  MARGIN_X,
  MESSAGE_ROW_HEIGHT,
  MESSAGE_TOP_CLEARANCE,
  NOTE_GAP,
  NOTE_HEIGHT,
  NOTE_MARGIN_Y,
  NOTE_ROW_HEIGHT,
  PARTICIPANT_BOX_HEIGHT,
  PARTICIPANT_SPACING,
  TITLE_HEIGHT,
} from "../../src/layout/geometry";
import { layoutDiagram } from "../../src/layout/sequence-layout";

/** Build a minimal SequenceDiagram AST for layout tests. */
function diagram(overrides: Partial<SequenceDiagram>): SequenceDiagram {
  return {
    title: undefined,
    participants: [],
    aliases: [],
    statements: [],
    notes: [],
    ...overrides,
  };
}

const LOGIN: SequenceDiagram = diagram({
  title: {
    value: "Login",
    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 5 } },
  },
  participants: [
    {
      type: "participant",
      id: "User",
      label: "User",
      range: { start: { line: 2, column: 0 }, end: { line: 2, column: 12 } },
    },
    {
      type: "participant",
      id: "API",
      label: "API",
      range: { start: { line: 3, column: 0 }, end: { line: 3, column: 11 } },
    },
    {
      type: "participant",
      id: "DB",
      label: "DB",
      range: { start: { line: 4, column: 0 }, end: { line: 4, column: 10 } },
    },
  ],
  statements: [
    {
      type: "message",
      kind: "sync",
      from: "User",
      to: "API",
      label: "Login",
      range: { start: { line: 6, column: 0 }, end: { line: 6, column: 12 } },
    },
    {
      type: "message",
      kind: "sync",
      from: "API",
      to: "DB",
      label: "Find user",
      range: { start: { line: 7, column: 0 }, end: { line: 7, column: 15 } },
    },
    {
      type: "message",
      kind: "response",
      from: "DB",
      to: "API",
      label: "User",
      range: { start: { line: 8, column: 0 }, end: { line: 8, column: 12 } },
    },
    {
      type: "message",
      kind: "response",
      from: "API",
      to: "User",
      label: "Token",
      range: { start: { line: 9, column: 0 }, end: { line: 9, column: 13 } },
    },
  ],
});

describe("layoutDiagram — empty diagram", () => {
  it("returns a minimal canvas with no participants or messages", () => {
    const layout = layoutDiagram(diagram({}));
    expect(layout.participants).toEqual([]);
    expect(layout.messages).toEqual([]);
    expect(layout.width).toBe(MARGIN_X * 2);
    // No title: height is just the participant box above the (empty) body.
    expect(layout.height).toBe(PARTICIPANT_BOX_HEIGHT + TITLE_HEIGHT);
  });
});

describe("layoutDiagram — participant placement", () => {
  it("spaces participants left-to-right on their own center x", () => {
    const layout = layoutDiagram(LOGIN);
    const xs = layout.participants.map((p) => p.x);
    // First center is MARGIN_X + spacing/2; each subsequent one is spacing apart.
    expect(xs[0]).toBe(MARGIN_X + PARTICIPANT_SPACING / 2);
    expect(xs[1]).toBe(xs[0] + PARTICIPANT_SPACING);
    expect(xs[2]).toBe(xs[1] + PARTICIPANT_SPACING);
  });

  it("gives every participant a bounded box width", () => {
    const layout = layoutDiagram(LOGIN);
    for (const p of layout.participants) {
      expect(p.width).toBeGreaterThanOrEqual(72);
    }
  });

  it("keeps a long label wider than the minimum", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            id: "A",
            label: "A".repeat(40),
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 5 },
            },
          },
        ],
      }),
    );
    expect(layout.participants[0].width).toBeGreaterThan(72);
  });
});

describe("layoutDiagram — message rows and canvas size", () => {
  it("stacks messages top-to-bottom in source order on their own rows", () => {
    const layout = layoutDiagram(LOGIN);
    const ys = layout.messages.map((m) => m.y);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBe(ys[i - 1] + MESSAGE_ROW_HEIGHT);
    }
    // First row starts just below the participant boxes, with clearance for
    // its own label above the arrow.
    expect(ys[0]).toBe(
      TITLE_HEIGHT + PARTICIPANT_BOX_HEIGHT * 2 + MESSAGE_TOP_CLEARANCE,
    );
  });

  it("sits arrow tails/heads exactly on the sender/receiver lifelines", () => {
    const layout = layoutDiagram(LOGIN);
    const byId = new Map(layout.participants.map((p) => [p.id, p.x]));
    for (const m of layout.messages) {
      expect(m.startX).toBe(byId.get(m.from));
      expect(m.endX).toBe(byId.get(m.to));
    }
  });

  it("lengthens the canvas for the number of messages", () => {
    const layout = layoutDiagram(LOGIN);
    const bodyTop =
      TITLE_HEIGHT + PARTICIPANT_BOX_HEIGHT * 2 + MESSAGE_TOP_CLEARANCE;
    expect(layout.height).toBe(
      bodyTop + layout.messages.length * MESSAGE_ROW_HEIGHT,
    );
  });

  it("widens the canvas to fit the participants", () => {
    const layout = layoutDiagram(LOGIN);
    expect(layout.width).toBe(
      MARGIN_X + layout.participants.length * PARTICIPANT_SPACING,
    );
  });

  it("flows the title text through to the layout", () => {
    const layout = layoutDiagram(LOGIN);
    expect(layout.title).toBe("Login");
  });

  it("omits the title when there is none", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            id: "A",
            label: "A",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 3 },
            },
          },
        ],
      }),
    );
    expect(layout.title).toBeUndefined();
  });

  it("is deterministic across repeated calls", () => {
    const a = layoutDiagram(LOGIN);
    const b = layoutDiagram(LOGIN);
    expect(a).toEqual(b);
  });
});

describe("layoutDiagram — alias resolution", () => {
  /**
   * An alias is a second name for a declared participant. The validator accepts
   * it anywhere a participant id is allowed, so layout must resolve it to the
   * same lifeline; otherwise the arrow tail falls back to the margin and the
   * message renders detached from every participant.
   */
  const ALIASED: SequenceDiagram = diagram({
    participants: [
      {
        type: "participant",
        id: "User",
        label: "User",
        range: { start: { line: 0, column: 0 }, end: { line: 0, column: 12 } },
      },
      {
        type: "participant",
        id: "API",
        label: "API",
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: 11 } },
      },
    ],
    aliases: [
      {
        type: "alias",
        alias: "U",
        target: "User",
        range: { start: { line: 2, column: 0 }, end: { line: 2, column: 9 } },
      },
    ],
    statements: [
      {
        type: "message",
        kind: "sync",
        from: "U",
        to: "API",
        label: "Login",
        range: { start: { line: 3, column: 0 }, end: { line: 3, column: 9 } },
      },
    ],
  });

  it("attaches an aliased sender's arrow to the target lifeline", () => {
    const layout = layoutDiagram(ALIASED);
    const user = layout.participants.find((p) => p.id === "User")!;
    const api = layout.participants.find((p) => p.id === "API")!;
    expect(layout.messages[0].startX).toBe(user.x);
    expect(layout.messages[0].endX).toBe(api.x);
  });

  it("never falls back to the margin for a resolvable alias", () => {
    const layout = layoutDiagram(ALIASED);
    expect(layout.messages[0].startX).not.toBe(MARGIN_X);
  });

  it("skips an alias whose target was never declared", () => {
    // The validator reports this; layout must stay total and not throw.
    const broken = diagram({
      participants: [
        {
          type: "participant",
          id: "A",
          label: "A",
          range: { start: { line: 0, column: 0 }, end: { line: 0, column: 3 } },
        },
      ],
      aliases: [
        {
          type: "alias",
          alias: "X",
          target: "Missing",
          range: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
        },
      ],
    });
    expect(() => layoutDiagram(broken)).not.toThrow();
  });
});

/** Build a note node anchored to a participant (or diagram-wide when omitted). */
function note(
  placement: NoteNode["placement"],
  participant?: NoteNode["participant"],
  text = "note",
): NoteNode {
  return {
    type: "note",
    placement,
    participant,
    text,
    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 4 } },
  };
}

describe("layoutDiagram — notes", () => {
  it("places a left note to the left of its participant lifeline", () => {
    // Two participants so the anchored one has room from the left margin.
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            id: "A",
            label: "A",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
          {
            type: "participant",
            id: "B",
            label: "B",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
        ],
        notes: [note("left", "B", "secret")],
      }),
    );
    const noteLayout = layout.notes[0];
    const bX = layout.participants[1].x;
    // Left note sits entirely to the left of the lifeline, with a gap.
    expect(noteLayout.x + noteLayout.width).toBeLessThanOrEqual(bX - NOTE_GAP);
  });

  it("places a right note to the right of its participant lifeline", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            id: "A",
            label: "A",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
          {
            type: "participant",
            id: "B",
            label: "B",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
        ],
        notes: [note("right", "B", "secret")],
      }),
    );
    const noteLayout = layout.notes[0];
    const bX = layout.participants[1].x;
    // Right note starts just to the right of the lifeline, after the gap.
    expect(noteLayout.x).toBeGreaterThanOrEqual(bX + NOTE_GAP);
  });

  it("centers an over note on its participant lifeline", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            id: "User",
            label: "User",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 4 },
            },
          },
        ],
        notes: [note("over", "User", "spanning")],
      }),
    );
    const noteLayout = layout.notes[0];
    const userX = layout.participants[0].x;
    // Centered over the lifeline means the box center aligns with it.
    expect(noteLayout.x + noteLayout.width / 2).toBeCloseTo(userX, 5);
  });

  it("positions a diagram-wide over note inside a centered span", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            id: "A",
            label: "A",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
          {
            type: "participant",
            id: "B",
            label: "B",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
        ],
        notes: [note("over", undefined, "shared")],
      }),
    );
    const noteLayout = layout.notes[0];
    // The box's left edge sits at the left edge of a span that is itself
    // centered on the canvas (span is capped at 192px here).
    const span = Math.min(192, layout.width - MARGIN_X * 2);
    expect(noteLayout.x).toBeCloseTo((layout.width - span) / 2, 5);
  });

  it("gives every note the fixed note height", () => {
    const layout = layoutDiagram(LOGIN);
    for (const n of layout.notes) {
      expect(n.height).toBe(NOTE_HEIGHT);
    }
  });

  it("stacks notes in their own band below the messages", () => {
    const layout = layoutDiagram(LOGIN);
    const messagesBottom =
      TITLE_HEIGHT +
      PARTICIPANT_BOX_HEIGHT * 2 +
      MESSAGE_TOP_CLEARANCE +
      layout.messages.length * MESSAGE_ROW_HEIGHT;
    const firstNoteY = messagesBottom + NOTE_MARGIN_Y;
    for (let i = 0; i < layout.notes.length; i++) {
      expect(layout.notes[i].y).toBe(
        firstNoteY + i * NOTE_ROW_HEIGHT + NOTE_MARGIN_Y,
      );
    }
  });

  it("widens the canvas to fit a right-anchored note", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            id: "A",
            label: "A",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
          {
            type: "participant",
            id: "B",
            label: "B",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
        ],
        notes: [note("right", "B", "a fairly long right note body")],
      }),
    );
    // A right note past the rightmost participant forces the canvas to widen.
    const rightmostParticipantRight =
      layout.participants[layout.participants.length - 1].x +
      layout.participants[layout.participants.length - 1].width / 2;
    expect(layout.width).toBeGreaterThan(rightmostParticipantRight);
  });

  it("lengthens the canvas to fit the notes band", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            id: "A",
            label: "A",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
        ],
        notes: [note("over", "A", "spans")],
      }),
    );
    // No title, so the body top is just below the participant boxes.
    const bodyBottom =
      PARTICIPANT_BOX_HEIGHT * 2 +
      MESSAGE_TOP_CLEARANCE +
      layout.messages.length * MESSAGE_ROW_HEIGHT;
    const expectedBottom =
      bodyBottom + layout.notes.length * NOTE_ROW_HEIGHT + NOTE_MARGIN_Y;
    expect(layout.height).toBe(expectedBottom);
  });

  it("leaves an empty notes array when the diagram has none", () => {
    const layout = layoutDiagram(LOGIN);
    expect(layout.notes).toEqual([]);
  });
});

/** Build an activation statement node. */
function activation(
  action: "activate" | "deactivate",
  participant: string,
): ActivationNode {
  return {
    type: "activation",
    action,
    participant,
    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 8 } },
  };
}

/** A one-participant diagram with a given statement list. */
function withStatements(statements: SequenceDiagram["statements"]) {
  return diagram({
    participants: [
      {
        type: "participant",
        id: "A",
        label: "A",
        range: { start: { line: 0, column: 0 }, end: { line: 0, column: 3 } },
      },
      {
        type: "participant",
        id: "B",
        label: "B",
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: 3 } },
      },
    ],
    statements,
  });
}

/** A message from A to B. */
function message(label: string) {
  return {
    type: "message" as const,
    kind: "sync" as const,
    from: "A",
    to: "B",
    label,
    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 9 } },
  };
}

describe("layoutDiagram — activations", () => {
  it("emits no bars when the diagram has no activations", () => {
    expect(layoutDiagram(LOGIN).activations).toEqual([]);
  });

  it("does not give an activation its own message row", () => {
    // The activation sits between the two messages, so rows stay one apart.
    const layout = layoutDiagram(
      withStatements([
        message("one"),
        activation("activate", "A"),
        message("two"),
      ]),
    );
    expect(layout.messages).toHaveLength(2);
    expect(layout.messages[1].y - layout.messages[0].y).toBe(
      MESSAGE_ROW_HEIGHT,
    );
  });

  it("spans a bar from its activate to its deactivate", () => {
    const layout = layoutDiagram(
      withStatements([
        message("one"),
        activation("activate", "A"),
        message("two"),
        activation("deactivate", "A"),
      ]),
    );
    expect(layout.activations).toHaveLength(1);
    const bar = layout.activations[0];
    expect(bar.participant).toBe("A");
    // Opens at the row of the message that follows `activate`...
    expect(bar.y).toBe(layout.messages[1].y);
    // ...and closes at the row that would follow the `deactivate`.
    expect(bar.height).toBe(MESSAGE_ROW_HEIGHT);
  });

  it("centers the bar on the participant lifeline", () => {
    const layout = layoutDiagram(
      withStatements([activation("activate", "A"), message("one")]),
    );
    const a = layout.participants.find((p) => p.id === "A")!;
    expect(layout.activations[0].x).toBe(a.x);
  });

  it("offsets nested bars so both stay visible", () => {
    const layout = layoutDiagram(
      withStatements([
        activation("activate", "A"),
        activation("activate", "A"),
        message("one"),
        activation("deactivate", "A"),
        activation("deactivate", "A"),
      ]),
    );
    expect(layout.activations).toHaveLength(2);
    const depths = layout.activations.map((b) => b.depth).sort();
    expect(depths).toEqual([0, 1]);
    // Bars close innermost-first, so select by depth rather than array order.
    const outer = layout.activations.find((b) => b.depth === 0)!;
    const inner = layout.activations.find((b) => b.depth === 1)!;
    const lifeline = layout.participants.find((p) => p.id === "A")!.x;
    expect(outer.x).toBe(lifeline);
    expect(inner.x).toBeGreaterThan(outer.x);
  });

  it("runs an unclosed bar to the bottom of the message body", () => {
    const layout = layoutDiagram(
      withStatements([activation("activate", "A"), message("one")]),
    );
    const a = layout.participants.find((p) => p.id === "A")!;
    const bar = layout.activations[0];
    expect(bar.y + bar.height).toBe(a.bottomY);
  });

  it("keeps a zero-length bar visible", () => {
    // activate and deactivate on the same row would otherwise be 0px tall.
    const layout = layoutDiagram(
      withStatements([
        activation("activate", "A"),
        activation("deactivate", "A"),
      ]),
    );
    expect(layout.activations[0].height).toBeGreaterThan(0);
  });

  it("ignores an activation of an unknown participant without throwing", () => {
    expect(() =>
      layoutDiagram(withStatements([activation("activate", "Ghost")])),
    ).not.toThrow();
  });

  it("ignores an unmatched deactivate without throwing", () => {
    const layout = layoutDiagram(
      withStatements([message("one"), activation("deactivate", "A")]),
    );
    expect(layout.activations).toEqual([]);
  });

  it("resolves an alias to the participant's lifeline", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            id: "User",
            label: "User",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 3 },
            },
          },
        ],
        aliases: [
          {
            type: "alias",
            alias: "U",
            target: "User",
            range: {
              start: { line: 1, column: 0 },
              end: { line: 1, column: 5 },
            },
          },
        ],
        statements: [activation("activate", "U")],
      }),
    );
    const user = layout.participants[0];
    expect(layout.activations[0].participant).toBe("User");
    expect(layout.activations[0].x).toBe(user.x);
  });
});

describe("layoutDiagram — vertical bands", () => {
  it("places the first message row clear of the participant boxes", () => {
    const layout = layoutDiagram(LOGIN);
    const boxBottom = layout.participants[0].topY + PARTICIPANT_BOX_HEIGHT;
    expect(layout.messages[0].y).toBeGreaterThan(boxBottom);
  });

  it("leaves room for the first row's label above its arrow", () => {
    const layout = layoutDiagram(LOGIN);
    const boxBottom = layout.participants[0].topY + PARTICIPANT_BOX_HEIGHT;
    // The renderer draws a label 6px above the arrow line.
    expect(layout.messages[0].y - 6).toBeGreaterThan(boxBottom);
  });

  it("derives the box top from the title, so both bands stay in step", () => {
    const titled = layoutDiagram(LOGIN);
    expect(titled.participants[0].topY).toBe(
      TITLE_HEIGHT + PARTICIPANT_BOX_HEIGHT,
    );

    const untitled = layoutDiagram(
      diagram({
        participants: LOGIN.participants,
        statements: LOGIN.statements,
      }),
    );
    // No title band, so the boxes move up by exactly the title height.
    expect(untitled.participants[0].topY).toBe(PARTICIPANT_BOX_HEIGHT);
    expect(titled.participants[0].topY - untitled.participants[0].topY).toBe(
      TITLE_HEIGHT,
    );
  });

  it("keeps the canvas tall enough for the boxes when there is no title", () => {
    // Regression: boxes were positioned with a title allowance the canvas
    // height did not account for, so an untitled diagram clipped them and drew
    // its first message above them.
    const untitled = layoutDiagram(
      diagram({ participants: LOGIN.participants }),
    );
    const box = untitled.participants[0];
    expect(untitled.height).toBeGreaterThanOrEqual(
      box.topY + PARTICIPANT_BOX_HEIGHT,
    );
    expect(untitled.messages).toEqual([]);
  });

  it("never places a message row above the boxes, titled or not", () => {
    for (const title of [undefined, LOGIN.title]) {
      const layout = layoutDiagram(
        diagram({
          title,
          participants: LOGIN.participants,
          statements: LOGIN.statements,
        }),
      );
      const boxBottom = layout.participants[0].topY + PARTICIPANT_BOX_HEIGHT;
      for (const message of layout.messages) {
        expect(message.y).toBeGreaterThan(boxBottom);
      }
    }
  });
});
