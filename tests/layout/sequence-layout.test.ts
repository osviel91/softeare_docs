import { describe, expect, it } from "vitest";
import type {
  ActivationNode,
  AltNode,
  LoopNode,
  MessageNode,
  NoteNode,
  ParticipantNode,
  SequenceDiagram,
} from "../../src/domain/diagram/ast";
import {
  ACTOR_HEIGHT,
  FRAGMENT_DIVIDER_HEIGHT,
  FRAGMENT_HEADER_HEIGHT,
  MARGIN_X,
  MESSAGE_ROW_HEIGHT,
  MESSAGE_TOP_CLEARANCE,
  NOTE_BULLET_SPACING,
  NOTE_BULLET_TOP_OFFSET,
  NOTE_GAP,
  NOTE_HEIGHT,
  NOTE_LINE_HEIGHT,
  PARTICIPANT_BOX_HEIGHT,
  PARTICIPANT_SPACING,
  SELF_MESSAGE_HEIGHT,
  SELF_MESSAGE_LABEL_GAP,
  SELF_MESSAGE_WIDTH,
  TITLE_HEIGHT,
} from "../../src/layout/geometry";
import { layoutDiagram } from "../../src/layout/sequence-layout";
import { parse } from "../../src/language/parser/parser";

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
      participantType: "participant",
      id: "User",
      label: "User",
      range: { start: { line: 2, column: 0 }, end: { line: 2, column: 12 } },
    },
    {
      type: "participant",
      participantType: "participant",
      id: "API",
      label: "API",
      range: { start: { line: 3, column: 0 }, end: { line: 3, column: 11 } },
    },
    {
      type: "participant",
      participantType: "participant",
      id: "DB",
      label: "DB",
      range: { start: { line: 4, column: 0 }, end: { line: 4, column: 10 } },
    },
  ],
  statements: [
    {
      type: "message",
      lineStyle: "solid",
      arrowStyle: "arrow",
      from: "User",
      to: "API",
      label: "Login",
      range: { start: { line: 6, column: 0 }, end: { line: 6, column: 12 } },
    },
    {
      type: "message",
      lineStyle: "solid",
      arrowStyle: "arrow",
      from: "API",
      to: "DB",
      label: "Find user",
      range: { start: { line: 7, column: 0 }, end: { line: 7, column: 15 } },
    },
    {
      type: "message",
      lineStyle: "dashed",
      arrowStyle: "none",
      from: "DB",
      to: "API",
      label: "User",
      range: { start: { line: 8, column: 0 }, end: { line: 8, column: 12 } },
    },
    {
      type: "message",
      lineStyle: "dashed",
      arrowStyle: "none",
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
            participantType: "participant",
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

  it("separates long participant headers and keeps them within the canvas", () => {
    const layout = layoutDiagram(
      diagram({
        participants: ["A", "B"].map((id) => ({
          type: "participant",
          participantType: "participant",
          id,
          label: `${id} ${"long label ".repeat(12)}`,
          range: {
            start: { line: 0, column: 0 },
            end: { line: 0, column: 5 },
          },
        })),
      }),
    );
    const [first, second] = layout.participants;

    expect(second.x - second.width / 2).toBeGreaterThanOrEqual(
      first.x + first.width / 2 + PARTICIPANT_SPACING - 72,
    );
    expect(first.x - first.width / 2).toBeGreaterThanOrEqual(MARGIN_X);
    expect(layout.width).toBeGreaterThanOrEqual(
      second.x + second.width / 2 + MARGIN_X,
    );
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
            participantType: "participant",
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
        participantType: "participant",
        id: "User",
        label: "User",
        range: { start: { line: 0, column: 0 }, end: { line: 0, column: 12 } },
      },
      {
        type: "participant",
        participantType: "participant",
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
        lineStyle: "solid",
        arrowStyle: "arrow",
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
          participantType: "participant",
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

/** Build a note node anchored to participant(s) (or diagram-wide when empty). */
function note(
  placement: NoteNode["placement"],
  participants: string | string[] = [],
  text = "note",
): NoteNode {
  return {
    type: "note",
    placement,
    participants: Array.isArray(participants)
      ? participants
      : participants
        ? [participants]
        : [],
    text,
    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 4 } },
  };
}

describe("layoutDiagram — notes", () => {
  it("attaches a left note's bullet to the left of its participant lifeline", () => {
    // Two participants so the anchored one has room from the left margin.
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            participantType: "participant",
            id: "A",
            label: "A",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
          {
            type: "participant",
            participantType: "participant",
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
    // The bullet is attached to the left of the lifeline...
    expect(noteLayout.anchorX).toBeLessThan(bX);
    // ...and the expanded box sits further left, clear of the bullet.
    expect(noteLayout.x + noteLayout.width).toBeLessThanOrEqual(
      noteLayout.anchorX,
    );
  });

  it("attaches a right note's bullet to the right of its participant lifeline", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            participantType: "participant",
            id: "A",
            label: "A",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
          {
            type: "participant",
            participantType: "participant",
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
    // The bullet starts just to the right of the lifeline, and the box follows
    // it after the gap.
    expect(noteLayout.anchorX).toBeGreaterThan(bX);
    expect(noteLayout.x).toBeGreaterThanOrEqual(noteLayout.anchorX + NOTE_GAP);
  });

  it("attaches an over note's bullet on its participant lifeline", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            participantType: "participant",
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
    // The bullet is centered on the lifeline and the box is centered under it.
    expect(noteLayout.anchorX).toBe(userX);
    expect(noteLayout.x + noteLayout.width / 2).toBeCloseTo(userX, 5);
  });

  it("anchors a diagram-wide over note at the top center of the diagram", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            participantType: "participant",
            id: "A",
            label: "A",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
          {
            type: "participant",
            participantType: "participant",
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
    expect(noteLayout.anchorX).toBeCloseTo(layout.width / 2, 5);
  });

  it("attaches every bullet just below the participant box", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            participantType: "participant",
            id: "A",
            label: "A",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
          {
            type: "participant",
            participantType: "participant",
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
    const box = layout.participants[1];
    expect(layout.notes[0].anchorY).toBeGreaterThan(
      box.topY + PARTICIPANT_BOX_HEIGHT,
    );
  });

  it("gives every note the fixed note height", () => {
    const layout = layoutDiagram(LOGIN);
    for (const n of layout.notes) {
      expect(n.height).toBe(NOTE_HEIGHT);
    }
  });

  it("stacks bullets attached to the same lifeline so both stay clickable", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            participantType: "participant",
            id: "A",
            label: "A",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
          {
            type: "participant",
            participantType: "participant",
            id: "B",
            label: "B",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
        ],
        notes: [note("right", "B", "first"), note("right", "B", "second")],
      }),
    );
    expect(layout.notes[1].anchorY - layout.notes[0].anchorY).toBe(
      NOTE_BULLET_SPACING,
    );
    expect(layout.notes[1].anchorX).toBe(layout.notes[0].anchorX);
  });

  it("widens the canvas to fit a right-anchored note", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            participantType: "participant",
            id: "A",
            label: "A",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 0, column: 1 },
            },
          },
          {
            type: "participant",
            participantType: "participant",
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

  it("keeps the canvas height at the message body so toggling never re-fits", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          {
            type: "participant",
            participantType: "participant",
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
    // No title, so the body bottom is just below the participant boxes. Notes
    // are an overlay and must not lengthen the canvas.
    const bodyBottom =
      PARTICIPANT_BOX_HEIGHT * 2 +
      MESSAGE_TOP_CLEARANCE +
      layout.messages.length * MESSAGE_ROW_HEIGHT;
    expect(layout.height).toBe(bodyBottom);
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
        participantType: "participant",
        id: "A",
        label: "A",
        range: { start: { line: 0, column: 0 }, end: { line: 0, column: 3 } },
      },
      {
        type: "participant",
        participantType: "participant",
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
    lineStyle: "solid" as const,
    arrowStyle: "arrow" as const,
    from: "A",
    to: "B",
    label,
    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 9 } },
  };
}

/** A message from a participant to itself. */
function selfMessage(label: string, participant = "A") {
  return {
    type: "message" as const,
    lineStyle: "solid" as const,
    arrowStyle: "arrow" as const,
    from: participant,
    to: participant,
    label,
    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 9 } },
  };
}

describe("layoutDiagram — self messages", () => {
  /** A single participant, so a loop's right edge is not lost in the canvas. */
  function oneParticipant(statements: SequenceDiagram["statements"]) {
    return diagram({
      participants: [
        {
          type: "participant",
          participantType: "participant",
          id: "A",
          label: "A",
          range: {
            start: { line: 0, column: 0 },
            end: { line: 0, column: 3 },
          },
        },
      ],
      statements,
    });
  }

  it("marks a self-message with loop geometry on its own lifeline", () => {
    const layout = layoutDiagram(withStatements([selfMessage("Work")]));
    const msg = layout.messages[0];
    const a = layout.participants.find((p) => p.id === "A")!;
    // Both endpoints are the same lifeline...
    expect(msg.startX).toBe(a.x);
    expect(msg.endX).toBe(a.x);
    // ...which is exactly the case the renderer turns into a loop.
    expect(msg.selfLoop).toEqual({
      width: SELF_MESSAGE_WIDTH,
      height: SELF_MESSAGE_HEIGHT,
    });
  });

  it("leaves an ordinary message without loop geometry", () => {
    const layout = layoutDiagram(withStatements([message("one")]));
    expect(layout.messages[0].selfLoop).toBeUndefined();
  });

  it("treats an alias of the same participant as a self-message", () => {
    // `U -> A` where `U` is an alias of `A` is the same lifeline, so it loops.
    const layout = layoutDiagram({
      ...withStatements([selfMessage("Work", "U")]),
      aliases: [
        {
          type: "alias",
          alias: "U",
          target: "A",
          range: { start: { line: 2, column: 0 }, end: { line: 2, column: 9 } },
        },
      ],
    });
    expect(layout.messages[0].selfLoop).toBeDefined();
  });

  it("does not treat two unknown endpoints as a self-message", () => {
    // An unresolved participant is a semantic error, not a loop.
    const layout = layoutDiagram(
      withStatements([selfMessage("Work", "Ghost")]),
    );
    expect(layout.messages[0].selfLoop).toBeUndefined();
  });

  it("widens the canvas to fit the loop and its label", () => {
    const layout = layoutDiagram(oneParticipant([selfMessage("Process")]));
    const a = layout.participants[0];
    const labelRight =
      a.x +
      SELF_MESSAGE_WIDTH +
      SELF_MESSAGE_LABEL_GAP +
      "Process".length * 7 +
      8;
    expect(layout.width).toBeGreaterThanOrEqual(labelRight);
  });

  it("gives a self-message its own row like any other message", () => {
    const layout = layoutDiagram(
      withStatements([selfMessage("one"), selfMessage("two")]),
    );
    expect(layout.messages[1].y - layout.messages[0].y).toBe(
      MESSAGE_ROW_HEIGHT,
    );
  });

  it("keeps the loop inside the message band", () => {
    const layout = layoutDiagram(oneParticipant([selfMessage("Work")]));
    const msg = layout.messages[0];
    // The loop must not reach into the row below.
    expect(msg.y + msg.selfLoop!.height).toBeLessThan(
      msg.y + MESSAGE_ROW_HEIGHT,
    );
  });
});

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
            participantType: "participant",
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

/** Build a participant/actor node for hand-written ASTs. */
function participantNode(
  id: string,
  participantType: "participant" | "actor" = "participant",
): ParticipantNode {
  return {
    type: "participant",
    participantType,
    id,
    label: id,
    range: {
      start: { line: 0, column: 0 },
      end: { line: 0, column: id.length },
    },
  };
}

/** Build a message node with a solid arrow by default. */
function messageNode(from: string, to: string, label = ""): MessageNode {
  return {
    type: "message",
    lineStyle: "solid",
    arrowStyle: "arrow",
    from,
    to,
    label,
    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 9 } },
  };
}

const RANGE = {
  start: { line: 0, column: 0 },
  end: { line: 0, column: 4 },
} as const;

describe("layoutDiagram — actors", () => {
  it("marks a lifeline as an actor and grows the participant band", () => {
    const layout = layoutDiagram(
      diagram({
        title: LOGIN.title,
        participants: [
          participantNode("User", "actor"),
          participantNode("API"),
        ],
        statements: [messageNode("User", "API", "Login")],
      }),
    );
    expect(layout.participants[0].participantType).toBe("actor");
    expect(layout.participants[1].participantType).toBe("participant");
    // The band is a full actor tall, so the figure and the label both fit.
    expect(layout.participants[0].topY).toBe(TITLE_HEIGHT + ACTOR_HEIGHT);
    expect(layout.participants[0].lifelineTop).toBe(
      TITLE_HEIGHT + ACTOR_HEIGHT * 2,
    );
    // Every lifeline in the diagram starts below the same band.
    expect(layout.participants[1].lifelineTop).toBe(
      layout.participants[0].lifelineTop,
    );
  });

  it("keeps the plain-participant band when there is no actor", () => {
    const layout = layoutDiagram(LOGIN);
    expect(layout.participants[0].topY).toBe(
      TITLE_HEIGHT + PARTICIPANT_BOX_HEIGHT,
    );
    expect(layout.participants[0].lifelineTop).toBe(
      TITLE_HEIGHT + PARTICIPANT_BOX_HEIGHT * 2,
    );
  });

  it("starts the first message row below the actor band", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          participantNode("User", "actor"),
          participantNode("API"),
        ],
        statements: [messageNode("User", "API")],
      }),
    );
    expect(layout.messages[0].y).toBe(ACTOR_HEIGHT * 2 + MESSAGE_TOP_CLEARANCE);
  });
});

describe("layoutDiagram — fragments", () => {
  /** A loop fragment wrapping the given statements. */
  function loopNode(statements: MessageNode[], label = "retry"): LoopNode {
    return { type: "loop", label, statements, range: RANGE };
  }

  it("draws a frame that brackets the rows its fragment contains", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [participantNode("A"), participantNode("B")],
        statements: [
          loopNode([
            messageNode("A", "B", "one"),
            messageNode("B", "A", "two"),
          ]),
        ],
      }),
    );
    const frames = layout.fragments ?? [];
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame.kind).toBe("loop");
    expect(frame.label).toBe("retry");
    expect(frame.depth).toBe(0);
    expect(frame.dividers).toEqual([]);
    // The header sits above the first row; the frame closes below the last.
    expect(frame.y).toBeLessThan(layout.messages[0].y);
    expect(frame.y + frame.height).toBeGreaterThan(layout.messages[1].y);
    expect(frame.height).toBeGreaterThan(FRAGMENT_HEADER_HEIGHT);
  });

  it("spans the participant boxes its fragment mentions", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [
          participantNode("A"),
          participantNode("B"),
          participantNode("C"),
        ],
        statements: [loopNode([messageNode("A", "B")])],
      }),
    );
    const frame = (layout.fragments ?? [])[0];
    const [a, b, c] = layout.participants;
    // A and B are inside the frame; the untouched C is outside it.
    expect(frame.x).toBeLessThan(a.x);
    expect(frame.x + frame.width).toBeGreaterThan(b.x);
    expect(frame.x + frame.width).toBeLessThan(c.x);
  });

  it("adds one divider per extra alt branch, labelled with its condition", () => {
    const alt: AltNode = {
      type: "alt",
      branches: [
        {
          condition: "user exists",
          statements: [messageNode("A", "B")],
          range: RANGE,
        },
        {
          condition: "user missing",
          statements: [messageNode("B", "A")],
          range: RANGE,
        },
      ],
      range: RANGE,
    };
    const layout = layoutDiagram(
      diagram({
        participants: [participantNode("A"), participantNode("B")],
        statements: [alt],
      }),
    );
    const frame = (layout.fragments ?? [])[0];
    expect(frame.kind).toBe("alt");
    expect(frame.label).toBe("user exists");
    expect(frame.dividers).toHaveLength(1);
    expect(frame.dividers[0].label).toBe("user missing");
    // The divider falls between the two branch rows.
    const dividerY = frame.dividers[0].y;
    expect(dividerY).toBeGreaterThan(layout.messages[0].y);
    expect(dividerY).toBeLessThan(layout.messages[1].y);
    // A second branch costs exactly the divider band.
    expect(layout.messages[1].y - layout.messages[0].y).toBe(
      MESSAGE_ROW_HEIGHT + FRAGMENT_DIVIDER_HEIGHT,
    );
  });

  it("nests an inner frame inside its outer frame", () => {
    const inner: LoopNode = {
      type: "loop",
      label: "inner",
      statements: [messageNode("A", "B", "deep")],
      range: RANGE,
    };
    const outer: LoopNode = {
      type: "loop",
      label: "outer",
      statements: [inner],
      range: RANGE,
    };
    const layout = layoutDiagram(
      diagram({
        participants: [participantNode("A"), participantNode("B")],
        statements: [outer],
      }),
    );
    const frames = layout.fragments ?? [];
    const outerFrame = frames.find((f) => f.depth === 0)!;
    const innerFrame = frames.find((f) => f.depth === 1)!;
    expect(innerFrame).toBeDefined();
    expect(innerFrame.y).toBeGreaterThan(outerFrame.y);
    expect(innerFrame.x).toBeGreaterThan(outerFrame.x);
    expect(innerFrame.x + innerFrame.width).toBeLessThan(
      outerFrame.x + outerFrame.width,
    );
    expect(innerFrame.y + innerFrame.height).toBeLessThanOrEqual(
      outerFrame.y + outerFrame.height,
    );
  });

  it("lengthens the canvas so the last fragment frame still fits", () => {
    const participants = [participantNode("A"), participantNode("B")];
    const plain = layoutDiagram(
      diagram({ participants, statements: [messageNode("A", "B")] }),
    );
    const framed = layoutDiagram(
      diagram({
        participants,
        statements: [loopNode([messageNode("A", "B")])],
      }),
    );
    expect(framed.height).toBeGreaterThan(plain.height);
    const frame = (framed.fragments ?? [])[0];
    expect(framed.height).toBeGreaterThanOrEqual(frame.y + frame.height);
  });

  it("emits no frames when the diagram has no fragments", () => {
    expect(layoutDiagram(LOGIN).fragments).toEqual([]);
  });
});

describe("layoutDiagram — spanning and multiline notes", () => {
  it("spans a note over two participants and centers its bullet", () => {
    const layout = layoutDiagram(
      diagram({
        participants: [participantNode("A"), participantNode("B")],
        notes: [
          {
            type: "note",
            placement: "over",
            participants: ["A", "B"],
            text: "Transaction boundary",
            range: RANGE,
          },
        ],
      }),
    );
    const note = layout.notes[0];
    const [a, b] = layout.participants;
    expect(note.participants).toEqual(["A", "B"]);
    expect(note.anchorX).toBe((a.x + b.x) / 2);
    // The box is wide enough to cover both lifelines.
    expect(note.width).toBeGreaterThanOrEqual(b.x - a.x);
    expect(note.x).toBeLessThanOrEqual(a.x);
    expect(note.x + note.width).toBeGreaterThanOrEqual(b.x);
  });

  it("grows a multiline note's box one line at a time", () => {
    const notes: NoteNode[] = [
      {
        type: "note",
        placement: "right",
        participants: ["A"],
        text: "one line",
        range: RANGE,
      },
      {
        type: "note",
        placement: "right",
        participants: ["A"],
        text: "first\nsecond\nthird",
        range: RANGE,
      },
    ];
    const layout = layoutDiagram(
      diagram({ participants: [participantNode("A")], notes }),
    );
    expect(layout.notes[0].height).toBe(NOTE_HEIGHT);
    expect(layout.notes[1].height).toBe(NOTE_HEIGHT + 2 * NOTE_LINE_HEIGHT);
  });
});

describe("layoutDiagram — notes on messages", () => {
  const participants = [participantNode("A"), participantNode("B")];
  const statements = [
    messageNode("A", "B", "one"),
    messageNode("B", "A", "two"),
  ];

  /** A note attached to message `number`. */
  function noteOn(number: number, text = "detail"): NoteNode {
    return {
      type: "note",
      placement: "on",
      participants: [],
      messageNumber: number,
      text,
      range: RANGE,
    };
  }

  it("anchors a note to the message its number names", () => {
    const layout = layoutDiagram(
      diagram({ participants, statements, notes: [noteOn(2)] }),
    );
    const note = layout.notes[0];
    const target = layout.messages[1];
    expect(note.messageNumber).toBe(2);
    expect(note.anchorX).toBe((target.startX + target.endX) / 2);
    expect(note.anchorY).toBe(target.y + NOTE_BULLET_TOP_OFFSET);
    // The box hangs below the arrow rather than covering it.
    expect(note.y).toBe(note.anchorY + NOTE_GAP);
    expect(note.y).toBeGreaterThan(target.y);
  });

  it("is independent of the message number: 1 targets the first row", () => {
    const layout = layoutDiagram(
      diagram({ participants, statements, notes: [noteOn(1)] }),
    );
    expect(layout.notes[0].anchorY).toBe(
      layout.messages[0].y + NOTE_BULLET_TOP_OFFSET,
    );
  });

  it("reserves canvas height so a note on the last message is not clipped", () => {
    const plain = layoutDiagram(diagram({ participants, statements }));
    const withNote = layoutDiagram(
      diagram({
        participants,
        statements,
        notes: [noteOn(2, "a longer note")],
      }),
    );
    const note = withNote.notes[0];
    expect(withNote.height).toBeGreaterThan(plain.height);
    expect(withNote.height).toBeGreaterThanOrEqual(note.y + note.height);
  });

  it("stacks two notes attached to the same message", () => {
    const layout = layoutDiagram(
      diagram({
        participants,
        statements,
        notes: [noteOn(1, "first"), noteOn(1, "second")],
      }),
    );
    expect(layout.notes[1].anchorY - layout.notes[0].anchorY).toBe(
      NOTE_BULLET_SPACING,
    );
  });

  it("anchors a note on a self-message to the middle of its loop", () => {
    const self: MessageNode = {
      type: "message",
      lineStyle: "solid",
      arrowStyle: "arrow",
      from: "A",
      to: "A",
      label: "work",
      range: RANGE,
    };
    const layout = layoutDiagram(
      diagram({
        participants: [participantNode("A")],
        statements: [self],
        notes: [noteOn(1)],
      }),
    );
    const message = layout.messages[0];
    expect(layout.notes[0].anchorX).toBe(
      message.startX + (message.selfLoop?.width ?? 0) / 2,
    );
  });

  it("falls back to the top center for a number the diagram never had", () => {
    // The validator reports this; layout must still be total and not throw.
    const layout = layoutDiagram(
      diagram({ participants, statements, notes: [noteOn(9)] }),
    );
    expect(layout.notes[0].anchorX).toBeGreaterThan(0);
    expect(layout.notes[0].anchorY).toBeGreaterThan(0);
  });
});

describe("layoutDiagram — node ids", () => {
  /**
   * A fixture with every addressable element: participants, messages, an
   * activation bar, a note, and two fragments with a divider each.
   */
  const SOURCE = `title Node ids
participant User
participant API
User -> API: Login
activate API
API --> User: Token
deactivate API
note over API: cached
alt found
  API -> User: ok
else missing
  API --> User: err
end
par left
  User -> API: l
and right
  API -> User: r
end
`;

  /** Lay out the shared fixture, failing loudly if it stops parsing. */
  function layoutFixture() {
    const { ast } = parse(SOURCE);
    if (ast === null) throw new Error("fixture failed to parse");
    return layoutDiagram(ast);
  }

  it("attaches a unique node id to every laid-out element", () => {
    const layout = layoutFixture();
    const elements = [
      ...layout.participants,
      ...layout.messages,
      ...layout.activations,
      ...(layout.fragments ?? []),
      ...(layout.fragments ?? []).flatMap((fragment) => fragment.dividers),
      ...layout.notes,
    ];
    // Guard the uniqueness assertion below against an empty fixture.
    expect(elements.length).toBeGreaterThan(8);
    const ids = elements.map((element) => element.nodeId);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(
      true,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("derives each id from the kind and range of its AST node", () => {
    const layout = layoutFixture();
    expect(layout.participants.map((p) => p.nodeId)).toEqual([
      "participant@1:0",
      "participant@2:0",
    ]);
    expect(layout.messages.map((m) => m.nodeId)).toEqual([
      "message@3:0",
      "message@5:0",
      "message@9:2",
      "message@11:2",
      "message@14:2",
      "message@16:2",
    ]);
    expect(layout.activations.map((a) => a.nodeId)).toEqual(["activation@4:0"]);
    expect(layout.notes.map((n) => n.nodeId)).toEqual(["note@7:0"]);
    expect((layout.fragments ?? []).map((f) => f.nodeId)).toEqual([
      "alt@8:0",
      "par@13:0",
    ]);
    expect(
      (layout.fragments ?? []).map((f) => f.dividers.map((d) => d.nodeId)),
    ).toEqual([["branch@10:0"], ["branch@15:0"]]);
  });
});
