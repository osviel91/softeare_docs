import { describe, expect, it } from "vitest";
import type {
  DiagramLayout,
  NoteLayout,
  ParticipantLayout,
} from "../../src/layout/geometry";
import {
  escapeXml,
  renderDiagramToSvg,
} from "../../src/renderer/svg/sequence-svg-renderer";

/** Build a participant with sensible geometry for rendering. */
function participant(id: string, label: string, x: number): ParticipantLayout {
  return { id, label, x, topY: 52, bottomY: 228, width: 72 };
}

/** A two-participant, one-message layout for focused assertions. */
function sampleLayout(): DiagramLayout {
  return {
    width: 264,
    height: 96,
    title: "Flow",
    participants: [participant("A", "A", 84), participant("B", "B", 204)],
    messages: [
      {
        from: "A",
        to: "B",
        kind: "sync",
        label: "hi",
        y: 96,
        startX: 84,
        endX: 204,
      },
    ],
    notes: [],
  };
}

/** Build a note layout positioned at a fixed box. */
function note(
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
): NoteLayout {
  return {
    placement: "left",
    participant: "A",
    text,
    x,
    y,
    width,
    height,
  };
}

describe("escapeXml", () => {
  it("escapes the XML-significant characters", () => {
    expect(escapeXml(`a&b<c>d"e`)).toBe("a&amp;b&lt;c&gt;d&quot;e");
  });

  it("leaves plain text untouched", () => {
    expect(escapeXml("Hello World")).toBe("Hello World");
  });
});

describe("renderDiagramToSvg — structure", () => {
  it("emits a well-formed svg root with the canvas dimensions", () => {
    const svg = renderDiagramToSvg(sampleLayout());
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain(`width="264"`);
    expect(svg).toContain(`height="96"`);
  });

  it("produces deterministic output for the same layout", () => {
    expect(renderDiagramToSvg(sampleLayout())).toBe(
      renderDiagramToSvg(sampleLayout()),
    );
  });

  it("never parses source text — it only consumes the layout", () => {
    // The renderer has no parser dependency; feed it a layout directly.
    const svg = renderDiagramToSvg(sampleLayout());
    expect(svg).toContain("<svg");
  });
});

describe("renderDiagramToSvg — participants", () => {
  it("renders a name box and a dashed lifeline per participant", () => {
    const svg = renderDiagramToSvg(sampleLayout());
    expect(svg).toContain("<rect");
    expect(svg).toContain('stroke-dasharray="4 3"');
    // The box width comes from the layout, not a hardcoded value.
    expect(svg).toContain(`width="72"`);
  });

  it("escapes special characters in participant labels", () => {
    const layout: DiagramLayout = {
      width: 200,
      height: 100,
      participants: [participant("A", "A & B <x>", 100)],
      messages: [],
      notes: [],
    };
    const svg = renderDiagramToSvg(layout);
    expect(svg).toContain("A &amp; B &lt;x&gt;");
  });
});

describe("renderDiagramToSvg — messages", () => {
  it("draws a filled arrowhead for a sync message", () => {
    const svg = renderDiagramToSvg(sampleLayout());
    expect(svg).toContain("<polygon");
    expect(svg).not.toContain('stroke-dasharray="5 4"');
  });

  it("draws a dashed, headless line for a response message", () => {
    const layout: DiagramLayout = {
      width: 200,
      height: 100,
      participants: [participant("A", "A", 84), participant("B", "B", 204)],
      messages: [
        {
          from: "A",
          to: "B",
          kind: "response",
          label: "",
          y: 96,
          startX: 84,
          endX: 204,
        },
      ],
      notes: [],
    };
    const svg = renderDiagramToSvg(layout);
    expect(svg).toContain('stroke-dasharray="5 4"');
    expect(svg).not.toContain("<polygon");
  });

  it("places a label above the arrow when present", () => {
    const svg = renderDiagramToSvg(sampleLayout());
    expect(svg).toContain(">hi<");
  });
});

describe("renderDiagramToSvg — title", () => {
  it("renders the title text centered near the top when present", () => {
    const svg = renderDiagramToSvg(sampleLayout());
    expect(svg).toContain(">Flow<");
  });

  it("omits the title element when the layout has none", () => {
    const layout: DiagramLayout = {
      width: 200,
      height: 100,
      participants: [participant("A", "A", 100)],
      messages: [],
      notes: [],
    };
    const svg = renderDiagramToSvg(layout);
    expect(svg).not.toContain(">Flow<");
  });
});

describe("renderDiagramToSvg — notes", () => {
  it("renders a folded note box for each note in the layout", () => {
    const layout: DiagramLayout = {
      width: 240,
      height: 160,
      participants: [participant("A", "A", 84), participant("B", "B", 204)],
      messages: [],
      notes: [note(96, 120, 120, 32, "secret")],
    };
    const svg = renderDiagramToSvg(layout);
    // A note is drawn as a folded-corner path, distinct from participant rects.
    expect(svg).toContain("<path");
    expect(svg).toContain('fill="#fff7d6"');
  });

  it("renders the note text inside the box", () => {
    const layout: DiagramLayout = {
      width: 240,
      height: 160,
      participants: [participant("A", "A", 84)],
      messages: [],
      notes: [note(96, 120, 120, 32, "confidential")],
    };
    const svg = renderDiagramToSvg(layout);
    expect(svg).toContain(">confidential<");
  });

  it("escapes special characters inside note text", () => {
    const layout: DiagramLayout = {
      width: 200,
      height: 120,
      participants: [participant("A", "A", 100)],
      messages: [],
      notes: [note(64, 120, 80, 32, "a & b <c>")],
    };
    const svg = renderDiagramToSvg(layout);
    expect(svg).toContain("a &amp; b &lt;c&gt;");
  });

  it("omits note elements when the layout has none", () => {
    const svg = renderDiagramToSvg(sampleLayout());
    expect(svg).not.toContain('fill="#fff7d6"');
  });
});
