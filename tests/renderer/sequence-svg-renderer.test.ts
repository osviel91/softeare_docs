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
    activations: [],
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
      activations: [],
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
      activations: [],
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
      activations: [],
    };
    const svg = renderDiagramToSvg(layout);
    expect(svg).not.toContain(">Flow<");
  });
});

describe("renderDiagramToSvg — well-formedness", () => {
  /**
   * Parse the SVG string the way a browser does. Substring assertions cannot
   * catch a tag that closes early: the markup still *contains* every expected
   * fragment, and only parsing reveals that elements ended up nested.
   */
  function parseSvg(svg: string): Document {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    return doc;
  }

  it("does not nest drawing elements inside a line", () => {
    // Regression: an early `>` on the message `<line>` made the arrowhead and
    // label children of the line. SVG ignores children of `<line>`, so every
    // message rendered as a bare stroke with no head and no label.
    const doc = parseSvg(renderDiagramToSvg(sampleLayout()));
    for (const line of Array.from(doc.querySelectorAll("line"))) {
      expect(line.children.length).toBe(0);
      expect(line.textContent).toBe("");
    }
  });

  it("emits no stray markup as text content", () => {
    // With the bug the raw string reads `...stroke-width="1.5">/>`: the tag is
    // closed early and the leftover `/>` becomes a text node.
    const svg = renderDiagramToSvg(sampleLayout());
    expect(svg).not.toContain(">/>");

    // Nothing but elements belongs directly under the root.
    const doc = parseSvg(svg);
    const strayText = Array.from(doc.documentElement.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join("")
      .trim();
    expect(strayText).toBe("");
  });

  it("starts each lifeline below its own name box", () => {
    // A lifeline drawn from the box top would dash straight across the label.
    const doc = parseSvg(renderDiagramToSvg(sampleLayout()));
    const lifeline = Array.from(doc.querySelectorAll("line")).find(
      (line) =>
        line.getAttribute("x1") === line.getAttribute("x2") &&
        line.getAttribute("x1") === "84.00",
    );
    expect(lifeline).toBeDefined();
    // Participant box spans y 52..76 in the fixture.
    expect(Number(lifeline!.getAttribute("y1"))).toBe(76);
  });

  it("draws one lifeline per participant and one line per message", () => {
    const doc = parseSvg(renderDiagramToSvg(sampleLayout()));
    const lines = doc.querySelectorAll("line");
    // Two participant lifelines plus the single message arrow.
    expect(lines.length).toBe(3);
  });

  it("keeps the message arrowhead and label as siblings of the line", () => {
    const doc = parseSvg(renderDiagramToSvg(sampleLayout()));
    const svg = doc.documentElement;
    expect(svg.querySelector("line > polygon")).toBeNull();
    expect(svg.querySelector("line > text")).toBeNull();
    // Both are still present, directly under the root.
    expect(svg.querySelector(":scope > polygon")).not.toBeNull();
    expect(svg.querySelector(":scope > text")).not.toBeNull();
  });

  it("carries the dash pattern as an attribute, not as child text", () => {
    const layout: DiagramLayout = {
      width: 200,
      height: 100,
      participants: [participant("A", "A", 84), participant("B", "B", 204)],
      messages: [
        {
          from: "A",
          to: "B",
          kind: "response",
          label: "back",
          y: 96,
          startX: 84,
          endX: 204,
        },
      ],
      notes: [],
      activations: [],
    };
    const doc = parseSvg(renderDiagramToSvg(layout));
    const messageLine = Array.from(doc.querySelectorAll("line")).find(
      (line) => line.getAttribute("stroke-dasharray") === "5 4",
    );
    expect(messageLine).toBeDefined();
    expect(messageLine?.textContent).toBe("");
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
      activations: [],
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
      activations: [],
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
      activations: [],
    };
    const svg = renderDiagramToSvg(layout);
    expect(svg).toContain("a &amp; b &lt;c&gt;");
  });

  it("omits note elements when the layout has none", () => {
    const svg = renderDiagramToSvg(sampleLayout());
    expect(svg).not.toContain('fill="#fff7d6"');
  });
});

describe("renderDiagramToSvg — activations", () => {
  /** A layout with one activation bar on participant A. */
  function layoutWithBar(): DiagramLayout {
    return {
      width: 264,
      height: 200,
      participants: [participant("A", "A", 84), participant("B", "B", 204)],
      messages: [],
      activations: [{ participant: "A", x: 84, y: 52, height: 88, depth: 0 }],
      notes: [],
    };
  }

  it("draws a bar as a rectangle centered on the lifeline", () => {
    const doc = new DOMParser().parseFromString(
      renderDiagramToSvg(layoutWithBar()),
      "image/svg+xml",
    );
    const rects = Array.from(doc.querySelectorAll("rect"));
    // The canvas background is white-filled too, so identify the bar by its
    // dark stroke; participant boxes use a slate stroke.
    const bar = rects.find((r) => r.getAttribute("stroke") === "#0f172a");
    expect(bar).toBeDefined();
    expect(Number(bar!.getAttribute("y"))).toBe(52);
    expect(Number(bar!.getAttribute("height"))).toBe(88);
    // Centered on x = 84 with the standard bar width.
    expect(Number(bar!.getAttribute("x"))).toBe(84 - 5);
    expect(Number(bar!.getAttribute("width"))).toBe(10);
  });

  it("renders no bar rectangles when the layout has no activations", () => {
    const svg = renderDiagramToSvg(sampleLayout());
    expect(svg).not.toContain('fill="#ffffff" stroke="#0f172a"');
  });

  it("draws bars over lifelines but under message arrows", () => {
    const layout = layoutWithBar();
    layout.messages = [
      {
        from: "A",
        to: "B",
        kind: "sync",
        label: "hi",
        y: 96,
        startX: 84,
        endX: 204,
      },
    ];
    const svg = renderDiagramToSvg(layout);
    // Source order decides paint order, so the bar precedes the arrow.
    expect(svg.indexOf('fill="#ffffff" stroke="#0f172a"')).toBeLessThan(
      svg.indexOf("<polygon"),
    );
  });
});
