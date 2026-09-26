import { describe, expect, it } from "vitest";
import {
  MESSAGE_BADGE_INSET,
  type DiagramLayout,
  type NoteLayout,
  type ParticipantLayout,
} from "../../src/layout/geometry";
import { layoutDiagram } from "../../src/layout/sequence-layout";
import { parse as parseSource } from "../../src/language/parser/parser";
import {
  diagramCanvasSize,
  escapeXml,
  renderDiagramToSvg,
} from "../../src/renderer/svg/sequence-svg-renderer";

/** Build a participant with sensible geometry for rendering. */
function participant(id: string, label: string, x: number): ParticipantLayout {
  return {
    id,
    label,
    participantType: "participant",
    x,
    topY: 52,
    lifelineTop: 76,
    bottomY: 228,
    width: 72,
  };
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
        lineStyle: "solid",
        arrowStyle: "arrow",
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

/** Build a note layout positioned at a fixed box, with its bullet beside it. */
function note(
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
): NoteLayout {
  return {
    placement: "left",
    participants: ["A"],
    text,
    anchorX: x + width + 8,
    anchorY: y + height / 2,
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

  it("renders semantic message metadata as a restrained text affordance", () => {
    const layout = sampleLayout();
    layout.messages[0].semantics = {
      name: "ExportCorporateBalanceProcessEndedEvent",
      kind: "event",
      operation: "publish",
      messageRef: "msg-exported",
      range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
    };
    const svg = renderDiagramToSvg(layout);
    expect(svg).toContain('class="semantic-message-badge"');
    expect(svg).toContain("EVENT · publish");
    expect(svg).toContain('data-semantic-message-id="msg-exported"');
    expect(svg).toContain('role="button"');
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

  it("marks each participant group as a draggable name", () => {
    // The editor accepts a dropped participant name, so the group must carry the
    // id the DSL understands plus enough markup to start a drag.
    const doc = new DOMParser().parseFromString(
      renderDiagramToSvg(sampleLayout()),
      "image/svg+xml",
    );
    const group = doc.querySelector('[data-participant-id="A"]');
    expect(group).not.toBeNull();
    expect(group!.getAttribute("draggable")).toBe("true");
    expect(group!.getAttribute("data-participant-label")).toBe("A");
  });

  it("escapes a participant id used as a drag attribute", () => {
    const layout: DiagramLayout = {
      width: 200,
      height: 100,
      participants: [participant('A"B', 'A"B', 100)],
      messages: [],
      notes: [],
      activations: [],
    };
    const svg = renderDiagramToSvg(layout);
    expect(svg).toContain('data-participant-id="A&quot;B"');
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
          lineStyle: "dashed",
          arrowStyle: "none",
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

describe("renderDiagramToSvg — sequence numbers", () => {
  /** Parse a rendered document, asserting it is well-formed. */
  function parse(svg: string): Document {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    return doc;
  }

  /** Three messages: a call, a response, and a self-message. */
  function numberedLayout(): DiagramLayout {
    return {
      width: 264,
      height: 200,
      participants: [participant("A", "A", 84), participant("B", "B", 204)],
      messages: [
        {
          from: "A",
          to: "B",
          lineStyle: "solid",
          arrowStyle: "arrow",
          label: "hi",
          y: 96,
          startX: 84,
          endX: 204,
        },
        {
          from: "B",
          to: "A",
          lineStyle: "dashed",
          arrowStyle: "none",
          label: "ok",
          y: 140,
          startX: 204,
          endX: 84,
        },
        {
          from: "A",
          to: "A",
          lineStyle: "solid",
          arrowStyle: "arrow",
          label: "again",
          y: 184,
          startX: 84,
          endX: 84,
          selfLoop: { width: 44, height: 24 },
        },
      ],
      notes: [],
      activations: [],
    };
  }

  it("numbers every call and response in source order", () => {
    const badges = Array.from(
      parse(renderDiagramToSvg(numberedLayout())).querySelectorAll(
        "[data-sequence-number]",
      ),
    );
    expect(
      badges.map((badge) => badge.getAttribute("data-sequence-number")),
    ).toEqual(["1", "2", "3"]);
    // The digit itself is drawn inside the badge.
    expect(badges.map((badge) => badge.textContent)).toEqual(["1", "2", "3"]);
  });

  it("sits on the arrow just inside the sender's lifeline", () => {
    const doc = parse(renderDiagramToSvg(numberedLayout()));
    const circle = doc.querySelector(
      "[data-sequence-number='1'] circle",
    ) as Element;
    // A -> B leaves x = 84 travelling right.
    expect(Number(circle.getAttribute("cx"))).toBe(84 + MESSAGE_BADGE_INSET);
    expect(Number(circle.getAttribute("cy"))).toBe(96);
  });

  it("mirrors the badge for a message that travels right-to-left", () => {
    const doc = parse(renderDiagramToSvg(numberedLayout()));
    const circle = doc.querySelector(
      "[data-sequence-number='2'] circle",
    ) as Element;
    // B -> A leaves x = 204 travelling left.
    expect(Number(circle.getAttribute("cx"))).toBe(204 - MESSAGE_BADGE_INSET);
  });

  it("numbers a self-message on the loop it draws", () => {
    const doc = parse(renderDiagramToSvg(numberedLayout()));
    const circle = doc.querySelector(
      "[data-sequence-number='3'] circle",
    ) as Element;
    // The loop's top segment leaves x = 84 to the right.
    expect(Number(circle.getAttribute("cx"))).toBe(84 + MESSAGE_BADGE_INSET);
    expect(Number(circle.getAttribute("cy"))).toBe(184);
  });

  it("omits step numbers when the diagram has no messages", () => {
    const layout: DiagramLayout = {
      width: 200,
      height: 100,
      participants: [participant("A", "A", 100)],
      messages: [],
      notes: [],
      activations: [],
    };
    expect(renderDiagramToSvg(layout)).not.toContain("data-sequence-number");
  });
});

describe("renderDiagramToSvg — self messages", () => {
  /** A layout with one self-message from A back to A. */
  function selfLayout(
    style: "sync" | "response",
    label = "Work",
  ): DiagramLayout {
    return {
      width: 264,
      height: 160,
      participants: [participant("A", "A", 84), participant("B", "B", 204)],
      messages: [
        {
          from: "A",
          to: "A",
          lineStyle: style === "sync" ? "solid" : "dashed",
          arrowStyle: style === "sync" ? "arrow" : "none",
          label,
          y: 96,
          startX: 84,
          endX: 84,
          selfLoop: { width: 44, height: 24 },
        },
      ],
      notes: [],
      activations: [],
    };
  }

  /** Parse the markup the way a browser would. */
  function parse(svg: string): Document {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    return doc;
  }

  it("draws a loop path instead of a zero-length horizontal line", () => {
    const doc = parse(renderDiagramToSvg(selfLayout("sync")));
    // Only the two lifelines remain as straight lines; the message is a path.
    expect(doc.querySelectorAll("line")).toHaveLength(2);
    const path = doc.querySelector("path");
    expect(path).not.toBeNull();
    // The loop leaves the lifeline (x=84), turns at x+44=128 and y+24=120.
    const d = path!.getAttribute("d") ?? "";
    expect(d).toContain("M84.00,96.00");
    expect(d).toContain("L128.00,96.00");
    expect(d).toContain("L128.00,120.00");
    expect(d).toContain("L84.00,120.00");
  });

  it("points the arrowhead back at the originating lifeline", () => {
    const doc = parse(renderDiagramToSvg(selfLayout("sync")));
    const points = doc.querySelector("polygon")?.getAttribute("points") ?? "";
    // Tip on the lifeline at the loop's bottom edge...
    expect(points).toContain("84.00,120.00");
    // ...with its base to the right, because the arrow points left.
    expect(points).toContain("92.00");
  });

  it("draws a headless, dashed loop for a response", () => {
    const svg = renderDiagramToSvg(selfLayout("response"));
    expect(svg).toContain('stroke-dasharray="5 4"');
    expect(svg).not.toContain("<polygon");
  });

  it("places the label beside the loop, not above it", () => {
    const doc = parse(renderDiagramToSvg(selfLayout("sync", "Refresh")));
    const label = doc.querySelector("text[font-size='12']");
    expect(label?.textContent).toBe("Refresh");
    // x = loop right edge (128) + gap (8), vertically centered on the loop.
    expect(Number(label!.getAttribute("x"))).toBe(136);
    expect(Number(label!.getAttribute("y"))).toBe(96 + 24 / 2 + 4);
  });

  it("escapes special characters in a self-message label", () => {
    const svg = renderDiagramToSvg(selfLayout("sync", "a & b <c>"));
    expect(svg).toContain("a &amp; b &lt;c&gt;");
  });

  it("produces well-formed markup for a self-message", () => {
    parse(renderDiagramToSvg(selfLayout("sync")));
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
    // Both are still present, alongside the line inside the message group.
    expect(svg.querySelector(".sequence-message > polygon")).not.toBeNull();
    expect(svg.querySelector(".sequence-message > text")).not.toBeNull();
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
          lineStyle: "dashed",
          arrowStyle: "none",
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
  /** A layout with a single note, for focused rendering assertions. */
  function layoutWithNote(text: string, width = 120): DiagramLayout {
    return {
      width: 240,
      height: 160,
      participants: [participant("A", "A", 84)],
      messages: [],
      notes: [note(24, 96, width, 32, text)],
      activations: [],
    };
  }

  it("renders a collapsed bullet attached to the note's element by default", () => {
    const svg = renderDiagramToSvg(layoutWithNote("secret"));
    // The bullet is the toggle control and carries the index the UI toggles.
    expect(svg).toContain('data-note-index="0"');
    expect(svg).toContain('role="button"');
    // Collapsed means no callout box (a folded-corner path) until expanded.
    expect(svg).not.toContain("<path");
  });

  it("renders the folded note box only when the note is expanded", () => {
    const svg = renderDiagramToSvg(layoutWithNote("secret"), {
      expandedNotes: new Set([0]),
    });
    // A note is drawn as a folded-corner path, distinct from participant rects.
    expect(svg).toContain("<path");
    expect(svg).toContain('fill="#fff7d6"');
    expect(svg).toContain('data-note-index="0"');
  });

  it("renders the note text inside an expanded box", () => {
    const svg = renderDiagramToSvg(layoutWithNote("confidential"), {
      expandedNotes: new Set([0]),
    });
    expect(svg).toContain(">confidential<");
  });

  it("escapes special characters inside note text", () => {
    const svg = renderDiagramToSvg(layoutWithNote("a & b <c>", 80), {
      expandedNotes: new Set([0]),
    });
    expect(svg).toContain("a &amp; b &lt;c&gt;");
  });

  it("leaves unexpanded notes out of the expanded set only", () => {
    const layout = layoutWithNote("secret");
    layout.notes = [
      note(24, 96, 120, 32, "first"),
      note(24, 128, 120, 32, "second"),
    ];
    const svg = renderDiagramToSvg(layout, { expandedNotes: new Set([1]) });
    // Both bullets exist; only the expanded note's body is drawn.
    expect(svg).toContain('data-note-index="0"');
    expect(svg).toContain('data-note-index="1"');
    expect(svg).toContain(">second<");
    expect(svg).not.toContain(">first<");
  });

  it("omits note elements when the layout has none", () => {
    const svg = renderDiagramToSvg(sampleLayout());
    expect(svg).not.toContain('fill="#fff7d6"');
    expect(svg).not.toContain("data-note-index");
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
    // Identify bars as rectangles, not by their fill/stroke substring: the
    // sequence-number badges share those colors but are circles.
    const doc = new DOMParser().parseFromString(
      renderDiagramToSvg(sampleLayout()),
      "image/svg+xml",
    );
    const bars = Array.from(doc.querySelectorAll("rect")).filter(
      (rect) => rect.getAttribute("stroke") === "#0f172a",
    );
    expect(bars).toHaveLength(0);
  });

  it("draws bars over lifelines but under message arrows", () => {
    const layout = layoutWithBar();
    layout.messages = [
      {
        from: "A",
        to: "B",
        lineStyle: "solid",
        arrowStyle: "arrow",
        label: "hi",
        y: 96,
        startX: 84,
        endX: 204,
      },
    ];
    const doc = new DOMParser().parseFromString(
      renderDiagramToSvg(layout),
      "image/svg+xml",
    );
    const bar = Array.from(doc.querySelectorAll("rect")).find(
      (rect) => rect.getAttribute("stroke") === "#0f172a",
    );
    const arrow = doc.querySelector("line[stroke='#0f172a']");
    expect(bar).toBeDefined();
    expect(arrow).not.toBeNull();
    // Document order decides paint order, so the bar precedes the arrow.
    expect(
      bar!.compareDocumentPosition(arrow!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("renderDiagramToSvg — arrow styles", () => {
  /** A one-message layout with the requested arrow style. */
  function styleLayout(
    arrowStyle: DiagramLayout["messages"][number]["arrowStyle"],
    lineStyle: "solid" | "dashed" = "solid",
  ): DiagramLayout {
    return {
      width: 264,
      height: 120,
      participants: [participant("A", "A", 84), participant("B", "B", 204)],
      messages: [
        {
          from: "A",
          to: "B",
          lineStyle,
          arrowStyle,
          label: "",
          y: 96,
          startX: 84,
          endX: 204,
        },
      ],
      notes: [],
      activations: [],
    };
  }

  it("draws a filled head for an 'arrow' ending", () => {
    const doc = new DOMParser().parseFromString(
      renderDiagramToSvg(styleLayout("arrow")),
      "image/svg+xml",
    );
    expect(doc.querySelectorAll("polygon")).toHaveLength(1);
    expect(doc.querySelector(".arrow-open")).toBeNull();
  });

  it("draws a chevron for an 'open' (async) ending", () => {
    const doc = new DOMParser().parseFromString(
      renderDiagramToSvg(styleLayout("open")),
      "image/svg+xml",
    );
    expect(doc.querySelector(".arrow-open")).not.toBeNull();
    expect(doc.querySelectorAll("polygon")).toHaveLength(0);
  });

  it("draws a cross for a failed-delivery ending", () => {
    const doc = new DOMParser().parseFromString(
      renderDiagramToSvg(styleLayout("cross")),
      "image/svg+xml",
    );
    expect(doc.querySelector(".arrow-cross")).not.toBeNull();
    expect(doc.querySelectorAll("polygon")).toHaveLength(0);
  });

  it("puts a head at both ends for a bidirectional ending", () => {
    const doc = new DOMParser().parseFromString(
      renderDiagramToSvg(styleLayout("bidirectional")),
      "image/svg+xml",
    );
    expect(doc.querySelectorAll("polygon")).toHaveLength(2);
  });

  it("draws no ending for 'none'", () => {
    const doc = new DOMParser().parseFromString(
      renderDiagramToSvg(styleLayout("none")),
      "image/svg+xml",
    );
    expect(doc.querySelectorAll("polygon")).toHaveLength(0);
    expect(doc.querySelector(".arrow-open")).toBeNull();
    expect(doc.querySelector(".arrow-cross")).toBeNull();
  });

  it("dashes the line only for the dashed line style", () => {
    const solid = renderDiagramToSvg(styleLayout("arrow", "solid"));
    const dashed = renderDiagramToSvg(styleLayout("arrow", "dashed"));
    expect(solid).not.toContain('stroke-dasharray="5 4"');
    expect(dashed).toContain('stroke-dasharray="5 4"');
  });
});

describe("renderDiagramToSvg — actors", () => {
  it("draws a stick figure for an actor lifeline", () => {
    const layout: DiagramLayout = {
      width: 200,
      height: 200,
      participants: [
        {
          id: "User",
          label: "User",
          participantType: "actor",
          x: 100,
          topY: 0,
          lifelineTop: 48,
          bottomY: 200,
          width: 72,
        },
      ],
      messages: [],
      notes: [],
      activations: [],
    };
    const doc = new DOMParser().parseFromString(
      renderDiagramToSvg(layout),
      "image/svg+xml",
    );
    const group = doc.querySelector("[data-participant-type='actor']");
    expect(group).not.toBeNull();
    // Head, body, arms and legs: the figure is a circle plus four lines.
    expect(group!.querySelectorAll("circle").length).toBeGreaterThanOrEqual(1);
    expect(group!.querySelectorAll("line").length).toBeGreaterThanOrEqual(4);
    expect(group!.textContent).toContain("User");
  });
});

describe("renderDiagramToSvg — fragment frames", () => {
  it("draws the frame, its kind tag, label and dividers", () => {
    const layout: DiagramLayout = {
      width: 264,
      height: 240,
      participants: [participant("A", "A", 84), participant("B", "B", 204)],
      messages: [],
      notes: [],
      activations: [],
      fragments: [
        {
          kind: "alt",
          label: "user exists",
          x: 40,
          y: 60,
          width: 200,
          height: 120,
          depth: 0,
          dividers: [{ y: 130, label: "user missing" }],
        },
      ],
    };
    const svg = renderDiagramToSvg(layout);
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const group = doc.querySelector("[data-fragment-kind='alt']");
    expect(group).not.toBeNull();
    expect(group!.textContent).toContain("user exists");
    expect(group!.textContent).toContain("user missing");
    // The frame outline is a rectangle spanning the given box.
    const rect = group!.querySelector("rect")!;
    expect(Number(rect.getAttribute("x"))).toBe(40);
    expect(Number(rect.getAttribute("width"))).toBe(200);
  });
});

describe("renderDiagramToSvg — multiline notes", () => {
  it("renders one text element per line of an expanded note", () => {
    const layout: DiagramLayout = {
      width: 240,
      height: 200,
      participants: [participant("A", "A", 84)],
      messages: [],
      activations: [],
      notes: [
        {
          placement: "right",
          participants: ["A"],
          text: "first\nsecond",
          anchorX: 84,
          anchorY: 120,
          x: 92,
          y: 104,
          width: 120,
          height: 47,
        },
      ],
    };
    const svg = renderDiagramToSvg(layout, { expandedNotes: new Set([0]) });
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const texts = Array.from(doc.querySelectorAll("text")).map(
      (node) => node.textContent,
    );
    expect(texts).toContain("first");
    expect(texts).toContain("second");
  });
});

describe("renderDiagramToSvg — notes on a message", () => {
  /** A layout whose only note is attached to a message step. */
  function layoutWithMessageNote(): DiagramLayout {
    return {
      width: 240,
      height: 220,
      participants: [participant("A", "A", 84), participant("B", "B", 204)],
      messages: [],
      activations: [],
      notes: [
        {
          placement: "on",
          participants: [],
          messageNumber: 1,
          text: "detail",
          anchorX: 144,
          anchorY: 120,
          x: 104,
          y: 134,
          width: 80,
          height: 32,
        },
      ],
    };
  }

  it("renders a collapsed bullet carrying its note index", () => {
    const doc = new DOMParser().parseFromString(
      renderDiagramToSvg(layoutWithMessageNote()),
      "image/svg+xml",
    );
    expect(doc.querySelector("[data-note-index='0']")).not.toBeNull();
    // Collapsed: no callout box yet.
    expect(doc.querySelector("path")).toBeNull();
  });

  it("draws a leader from the bullet down to the expanded box", () => {
    const svg = renderDiagramToSvg(layoutWithMessageNote(), {
      expandedNotes: new Set([0]),
    });
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(
      Array.from(doc.querySelectorAll("text")).map((t) => t.textContent),
    ).toContain("detail");
    // The leader ends at the box top (y = 134) and starts below the bullet.
    const leader = Array.from(doc.querySelectorAll("line")).find(
      (line) => line.getAttribute("y2") === "134.00",
    );
    expect(leader).toBeDefined();
    expect(Number(leader!.getAttribute("y1"))).toBeGreaterThan(120);
  });
});

describe("renderDiagramToSvg — node ids", () => {
  /** A fixture whose layout carries an id for every addressable element. */
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
`;

  /** Lay out the shared fixture, failing loudly if it stops parsing. */
  function layoutWithIds(): DiagramLayout {
    const { ast } = parseSource(SOURCE);
    if (ast === null) throw new Error("fixture failed to parse");
    return layoutDiagram(ast);
  }

  /** Parse the markup the way a browser would. */
  function parseSvg(svg: string): Document {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    return doc;
  }

  /** The same layout with every id removed, as a hand-built layout would be. */
  function clearNodeIds(layout: DiagramLayout): DiagramLayout {
    return {
      ...layout,
      participants: layout.participants.map((p) => ({
        ...p,
        nodeId: undefined,
      })),
      messages: layout.messages.map((m) => ({ ...m, nodeId: undefined })),
      activations: layout.activations.map((a) => ({ ...a, nodeId: undefined })),
      fragments: layout.fragments?.map((f) => ({
        ...f,
        nodeId: undefined,
        dividers: f.dividers.map((d) => ({ ...d, nodeId: undefined })),
      })),
      notes: layout.notes.map((n) => ({ ...n, nodeId: undefined })),
    };
  }

  it("marks the participant name box", () => {
    const layout = layoutWithIds();
    const doc = parseSvg(renderDiagramToSvg(layout));
    const id = layout.participants[0].nodeId as string;
    expect(doc.querySelector(`rect[data-node-id="${id}"]`)).not.toBeNull();
  });

  it("marks an actor's group element instead of a name box", () => {
    const { ast } = parseSource(
      "actor User\nparticipant API\nUser -> API: hi\n",
    );
    if (ast === null) throw new Error("fixture failed to parse");
    const layout = layoutDiagram(ast);
    const doc = parseSvg(renderDiagramToSvg(layout));
    const id = layout.participants[0].nodeId as string;
    expect(
      doc.querySelector(`g.participant--actor[data-node-id="${id}"]`),
    ).not.toBeNull();
  });

  it("marks a message arrow", () => {
    const layout = layoutWithIds();
    const doc = parseSvg(renderDiagramToSvg(layout));
    const id = layout.messages[0].nodeId as string;
    const arrow = doc.querySelector(`[data-node-id="${id}"]`);
    expect(arrow).not.toBeNull();
    expect(arrow?.tagName.toLowerCase()).toBe("line");
  });

  it("marks an activation bar", () => {
    const layout = layoutWithIds();
    const doc = parseSvg(renderDiagramToSvg(layout));
    const id = layout.activations[0].nodeId as string;
    expect(doc.querySelector(`rect[data-node-id="${id}"]`)).not.toBeNull();
  });

  it("marks a note bullet and its expanded callout box", () => {
    const layout = layoutWithIds();
    const id = layout.notes[0].nodeId as string;
    const doc = parseSvg(
      renderDiagramToSvg(layout, { expandedNotes: new Set([0]) }),
    );
    // The bullet is a group; the callout box is a path.
    expect(
      doc.querySelector(`g.note-bullet[data-node-id="${id}"]`),
    ).not.toBeNull();
    expect(doc.querySelector(`path[data-node-id="${id}"]`)).not.toBeNull();
  });

  it("marks a fragment frame and its divider", () => {
    const layout = layoutWithIds();
    const doc = parseSvg(renderDiagramToSvg(layout));
    const frame = layout.fragments?.[0];
    expect(frame?.nodeId).toBeDefined();
    expect(
      doc.querySelector(`g.fragment[data-node-id="${frame?.nodeId}"]`),
    ).not.toBeNull();
    const divider = frame?.dividers[0];
    expect(divider?.nodeId).toBeDefined();
    expect(
      doc.querySelector(`line[data-node-id="${divider?.nodeId}"]`),
    ).not.toBeNull();
  });

  it("emits no data-node-id for a hand-built layout without ids", () => {
    expect(renderDiagramToSvg(sampleLayout())).not.toContain("data-node-id");
  });

  it("emits no data-node-id when every layout element's id is cleared", () => {
    const withoutIds = clearNodeIds(layoutWithIds());
    expect(
      renderDiagramToSvg(withoutIds, { expandedNotes: new Set([0]) }),
    ).not.toContain("data-node-id");
  });

  it("changes nothing but the data-node-id attribute", () => {
    // Stripping the added attribute must reproduce the id-less markup exactly,
    // which is what keeps the rendered picture pixel-identical.
    const layout = layoutWithIds();
    const expandedNotes = new Set([0]);
    const withIds = renderDiagramToSvg(layout, { expandedNotes });
    const withoutIds = renderDiagramToSvg(clearNodeIds(layout), {
      expandedNotes,
    });
    expect(withIds.replace(/ data-node-id="[^"]*"/g, "")).toBe(withoutIds);
  });

  it("renders the same AST twice byte-identically", () => {
    const { ast } = parseSource(SOURCE);
    if (ast === null) throw new Error("fixture failed to parse");
    const first = renderDiagramToSvg(layoutDiagram(ast));
    const second = renderDiagramToSvg(layoutDiagram(ast));
    expect(first).toBe(second);
    // Guard the assertion above: ids must actually be present in the markup.
    expect(first).toContain("data-node-id");
  });
});

describe("renderDiagramToSvg — themes", () => {
  it("renders the explicit light theme byte-identically to the default", () => {
    // Existing callers pass no theme; the default must not move a single byte.
    expect(renderDiagramToSvg(sampleLayout(), { theme: "light" })).toBe(
      renderDiagramToSvg(sampleLayout()),
    );
  });

  it("renders a dark theme differently, with no light paper", () => {
    const light = renderDiagramToSvg(sampleLayout());
    const dark = renderDiagramToSvg(sampleLayout(), { theme: "dark" });
    expect(dark).not.toBe(light);
    // No white anywhere: the canvas, badge and activation fills all move.
    expect(dark).not.toContain('fill="#ffffff"');
    expect(dark).toContain('fill="#0f172a"');
  });

  it("uses a CSS colour verbatim for the background", () => {
    const svg = renderDiagramToSvg(sampleLayout(), {
      background: "#123456",
    });
    expect(svg).toContain('<rect width="264" height="96" fill="#123456"/>');
  });
});

describe("renderDiagramToSvg — background", () => {
  /** A layout with no messages, so the only white rect is the canvas. */
  function plainLayout(): DiagramLayout {
    return {
      width: 200,
      height: 100,
      participants: [participant("A", "A", 100)],
      messages: [],
      notes: [],
      activations: [],
    };
  }

  /** The number of rects painted in the given fill. */
  function rectsWithFill(svg: string, fill: string): number {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    return Array.from(doc.querySelectorAll("rect")).filter(
      (rect) => rect.getAttribute("fill") === fill,
    ).length;
  }

  it("paints the canvas white by default", () => {
    expect(rectsWithFill(renderDiagramToSvg(plainLayout()), "#ffffff")).toBe(1);
  });

  it("omits the background rectangle entirely when transparent", () => {
    const svg = renderDiagramToSvg(plainLayout(), {
      background: "transparent",
    });
    expect(rectsWithFill(svg, "#ffffff")).toBe(0);
    // The participant box is still drawn; only the canvas went away.
    expect(svg).toContain("<rect");
  });

  it("treats 'white' as the theme paper, so dark stays dark", () => {
    const svg = renderDiagramToSvg(plainLayout(), {
      theme: "dark",
      background: "white",
    });
    expect(rectsWithFill(svg, "#ffffff")).toBe(0);
    expect(rectsWithFill(svg, "#0f172a")).toBe(1);
  });
});

describe("renderDiagramToSvg — title toggle", () => {
  it("omits the title text when includeTitle is false", () => {
    const svg = renderDiagramToSvg(sampleLayout(), { includeTitle: false });
    expect(svg).not.toContain(">Flow<");
    // The rest of the diagram is untouched.
    expect(svg).toContain(">hi<");
  });

  it("draws the title by default and when includeTitle is true", () => {
    expect(renderDiagramToSvg(sampleLayout())).toContain(">Flow<");
    expect(
      renderDiagramToSvg(sampleLayout(), { includeTitle: true }),
    ).toContain(">Flow<");
  });
});

describe("renderDiagramToSvg — padding", () => {
  it("grows the canvas size honestly by twice the padding", () => {
    const layout = sampleLayout();
    const base = diagramCanvasSize(layout);
    const padded = diagramCanvasSize(layout, 20);
    expect(padded.width).toBe(base.width + 40);
    expect(padded.height).toBe(base.height + 40);
  });

  it("ignores a missing, zero, negative or non-finite padding", () => {
    const layout = sampleLayout();
    const base = diagramCanvasSize(layout);
    for (const value of [
      undefined,
      0,
      -5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(diagramCanvasSize(layout, value)).toEqual(base);
    }
  });

  it("grows the canvas and shifts the drawing inward", () => {
    const layout = sampleLayout();
    const base = diagramCanvasSize(layout);
    const svg = renderDiagramToSvg(layout, { padding: 20 });
    expect(svg).toContain(`width="${base.width + 40}"`);
    expect(svg).toContain(`height="${base.height + 40}"`);
    expect(svg).toContain('<g transform="translate(20, 20)">');

    // Participant A sits at x = 84 with a 72-wide box, so its left edge is 48.
    // The attribute keeps its layout coordinate; the wrapper group supplies the
    // shift, which is what keeps every element's geometry untouched.
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const box = Array.from(doc.querySelectorAll("rect")).find(
      (rect) => rect.getAttribute("stroke") === "#94a3b8",
    );
    expect(box).toBeDefined();
    expect(Number(box!.getAttribute("x"))).toBe(84 - 72 / 2);
    // Drawn inside the wrapper's own coordinate space, the drawing still fits
    // the unpadded canvas; the translate then places it `padding` px in.
    expect(Number(box!.getAttribute("x"))).toBeGreaterThanOrEqual(0);
    expect(Number(box!.getAttribute("x")) + 72).toBeLessThanOrEqual(base.width);
  });

  it("emits no wrapper group when there is no padding", () => {
    // The unpadded document must stay exactly as it was before this option.
    expect(renderDiagramToSvg(sampleLayout())).not.toContain(
      'transform="translate',
    );
  });
});
