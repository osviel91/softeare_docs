import { describe, expect, it } from "vitest";
import { layoutEventFlow } from "../../../src/layout/eventflow-layout";
import { eventFlowCanvasSize } from "../../../src/renderer/svg/eventflow-svg-renderer";
import {
  eventFlowSourceToSvg,
  renderEventFlow,
  renderEventFlowDocument,
} from "../../../src/features/preview/eventflow-to-svg";
import { parseEventFlow } from "../../../src/language/eventflow/parser";

const VALID = `title Order Processing
event OrderCreated
broker Kafka
topic orders on Kafka
producer OrderService
consumer BillingService
OrderService publishes OrderCreated to orders
BillingService consumes OrderCreated from orders
`;

describe("eventFlowSourceToSvg — valid source", () => {
  it("emits a well-formed svg containing the flow's labels", () => {
    const svg = eventFlowSourceToSvg(VALID);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain(">OrderCreated<");
    expect(svg).toContain(">OrderService<");
    expect(svg).toContain(">BillingService<");
    expect(svg).toContain(">orders<");
    // A fan-out edge ends in a filled arrowhead.
    expect(svg).toContain("<polygon");
  });

  it("renders a subscription-only event as a dashed declared-only row", () => {
    const svg = eventFlowSourceToSvg(`event Orphan
service C
C consumes Orphan
`);
    expect(svg).toContain(">Orphan<");
    expect(svg).toContain("eventflow-event--declared-only");
    expect(svg).toContain("(no producer)");
  });
});

describe("eventFlowSourceToSvg — empty and invalid source", () => {
  it("returns an empty canvas for an empty document", () => {
    const svg = eventFlowSourceToSvg("");
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).not.toContain("eventflow-row");
  });

  it("returns an empty canvas for unparseable source instead of throwing", () => {
    const svg = eventFlowSourceToSvg("@@@ not a statement ###");
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).not.toContain("eventflow-row");
    expect(svg).not.toContain("<polygon");
  });

  it("still renders the parseable part of a partly broken document", () => {
    const svg = eventFlowSourceToSvg(`${VALID}@@@ broken ###`);
    expect(svg).toContain(">OrderCreated<");
  });
});

describe("renderEventFlow — from an AST", () => {
  it("renders a parsed flow", () => {
    const { flow } = parseEventFlow(VALID);
    expect(renderEventFlow(flow)).toContain(">OrderCreated<");
  });

  it("renders null as an empty canvas", () => {
    const svg = renderEventFlow(null);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).not.toContain("eventflow-row");
  });

  it("renders a flow with no statements as an empty canvas", () => {
    const svg = renderEventFlow({ statements: [] });
    expect(svg).not.toContain("eventflow-row");
  });
});

describe("renderEventFlowDocument", () => {
  it("reports the canvas size the renderer drew", () => {
    const { flow } = parseEventFlow(VALID);
    const document = renderEventFlowDocument(flow);
    const size = eventFlowCanvasSize(layoutEventFlow(flow));
    expect(document.width).toBe(size.width);
    expect(document.height).toBe(size.height);
    expect(document.svg).toContain(`width="${size.width}"`);
  });

  it("reports the padded canvas size when padding is given", () => {
    const { flow } = parseEventFlow(VALID);
    const document = renderEventFlowDocument(flow, { padding: 8 });
    const size = eventFlowCanvasSize(layoutEventFlow(flow), 8);
    expect(document.width).toBe(size.width);
    expect(document.height).toBe(size.height);
  });

  it("threads render options through to the SVG", () => {
    const { flow } = parseEventFlow(VALID);
    const dark = renderEventFlowDocument(flow, { theme: "dark" }).svg;
    const light = renderEventFlowDocument(flow, { theme: "light" }).svg;
    expect(dark).not.toBe(light);

    const transparent = renderEventFlowDocument(flow, {
      background: "transparent",
    }).svg;
    expect(transparent).not.toContain('<rect width="');

    const untitled = renderEventFlowDocument(flow, {
      includeTitle: false,
    }).svg;
    expect(untitled).not.toContain("Order Processing");
  });

  it("renders a null flow with options without throwing", () => {
    const document = renderEventFlowDocument(null, { theme: "dark" });
    expect(document.svg.startsWith("<svg ")).toBe(true);
    expect(document.width).toBeGreaterThan(0);
    expect(document.height).toBeGreaterThan(0);
  });
});
