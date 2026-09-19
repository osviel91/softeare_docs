import { describe, expect, it } from "vitest";
import type { SequenceDiagram } from "../../src/domain/diagram/ast";
import {
  MARGIN_X,
  MESSAGE_ROW_HEIGHT,
  PARTICIPANT_BOX_HEIGHT,
  PARTICIPANT_SPACING,
  TITLE_HEIGHT,
} from "../../src/layout/geometry";
import { layoutDiagram } from "../../src/layout/sequence-layout";

/** Build a minimal SequenceDiagram AST for layout tests. */
function diagram(overrides: Partial<SequenceDiagram>): SequenceDiagram {
  return { title: undefined, participants: [], statements: [], ...overrides };
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
    // First row starts just below the participant box.
    expect(ys[0]).toBe(TITLE_HEIGHT + PARTICIPANT_BOX_HEIGHT);
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
    const topY = TITLE_HEIGHT + PARTICIPANT_BOX_HEIGHT;
    expect(layout.height).toBe(
      topY + layout.messages.length * MESSAGE_ROW_HEIGHT,
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
