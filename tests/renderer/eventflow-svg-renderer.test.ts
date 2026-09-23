import { describe, expect, it } from "vitest";
import {
  channelsOf,
  eventsOf,
  publicationsOf,
  subscriptionsOf,
  type EventFlow,
} from "../../src/domain/eventflow/ast";
import { projectEventFlowToFlowView } from "../../src/domain/eventflow/flow-projection";
import { nodeIdOf } from "../../src/domain/diagram/node-id";
import {
  EVENT_MARGIN_X,
  NO_PRODUCER_LABEL,
  layoutEventFlow as layoutFlow,
  type EventFlowLayout,
} from "../../src/layout/eventflow-layout";
import { parseEventFlow } from "../../src/language/eventflow/parser";
import {
  escapeXml,
  eventFlowCanvasSize,
  renderEventFlowToSvg,
} from "../../src/renderer/svg/eventflow-svg-renderer";

/** Parse source into the flow the layout engine consumes. */
function flowFrom(source: string): EventFlow {
  return parseEventFlow(source).flow;
}

/** Lay a source document out, so renderer tests exercise real geometry. */
function layoutOf(source: string): EventFlowLayout {
  return layoutFlow(projectEventFlowToFlowView(flowFrom(source)));
}

/** Parse an SVG string into a document, as the browser would. */
function documentOf(svg: string): Document {
  return new DOMParser().parseFromString(svg, "image/svg+xml");
}

const FAN_OUT = `title Order Processing
event OrderCreated
broker Kafka
topic orders on Kafka
producer OrderService
consumer BillingService
consumer InventoryService
consumer NotifyService
OrderService publishes OrderCreated to orders
BillingService consumes OrderCreated from orders
InventoryService consumes OrderCreated from orders
NotifyService consumes OrderCreated from orders
`;

const CYCLE = `event Ping
event Pong
service A
service B
A publishes Ping
B consumes Ping
B publishes Pong
A consumes Pong
`;

describe("escapeXml", () => {
  it("escapes the XML-significant characters", () => {
    expect(escapeXml(`a&b<c>d"e`)).toBe("a&amp;b&lt;c&gt;d&quot;e");
  });

  it("leaves plain text untouched", () => {
    expect(escapeXml("OrderCreated")).toBe("OrderCreated");
  });
});

describe("renderEventFlowToSvg — structure", () => {
  it("emits a well-formed svg root with a viewBox", () => {
    const layout = layoutOf(FAN_OUT);
    const svg = renderEventFlowToSvg(layout);
    const size = eventFlowCanvasSize(layout);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${size.width} ${size.height}"`);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("renders one row per event with its labels", () => {
    const svg = renderEventFlowToSvg(layoutOf(FAN_OUT));
    expect(svg).toContain(">OrderCreated<");
    expect(svg).toContain(">OrderService<");
    expect(svg).toContain(">BillingService<");
    expect(svg).toContain(">orders<");
  });

  it("is deterministic for the same layout", () => {
    const layout = layoutOf(FAN_OUT);
    expect(renderEventFlowToSvg(layout)).toBe(renderEventFlowToSvg(layout));
  });
});

describe("renderEventFlowToSvg — text escaping", () => {
  it("escapes a title that would otherwise inject markup", () => {
    const svg = renderEventFlowToSvg(
      layoutOf(`title <script>
event E
service S
S publishes E
`),
    );
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("escapes an event name that contains an ampersand", () => {
    const source = `event A&B
service S
S publishes A&B
`;
    const svg = renderEventFlowToSvg(layoutOf(source));
    expect(svg).toContain("A&amp;B");
    expect(svg).not.toContain(">A&B<");
  });
});

describe("renderEventFlowToSvg — data-node-id", () => {
  it("emits an id on the producer, channel, event and consumer boxes", () => {
    const flow = flowFrom(FAN_OUT);
    const layout = layoutFlow(projectEventFlowToFlowView(flow));
    const svg = renderEventFlowToSvg(layout);
    const rendered = new Set(
      Array.from(documentOf(svg).querySelectorAll("[data-node-id]")).map(
        (element) => element.getAttribute("data-node-id"),
      ),
    );

    const event = eventsOf(flow)[0];
    const channel = channelsOf(flow)[0];
    const publication = publicationsOf(flow)[0];
    const subscription = subscriptionsOf(flow)[0];
    expect(rendered.has(nodeIdOf("event", event.range))).toBe(true);
    expect(rendered.has(nodeIdOf("channel", channel.range))).toBe(true);
    expect(rendered.has(nodeIdOf("publication", publication.range))).toBe(true);
    expect(rendered.has(nodeIdOf("subscription", subscription.range))).toBe(
      true,
    );
  });

  it("keeps every declared row addressable exactly once", () => {
    const layout = layoutOf(FAN_OUT);
    const svg = renderEventFlowToSvg(layout);
    const elements = documentOf(svg).querySelectorAll("[data-node-id]");
    const ids = Array.from(elements).map((element) =>
      element.getAttribute("data-node-id"),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("renderEventFlowToSvg — fan-out", () => {
  it("draws one connecting line per consumer", () => {
    const layout = layoutOf(FAN_OUT);
    const svg = renderEventFlowToSvg(layout);
    const consumers = layout.rows.reduce(
      (total, row) => total + row.consumers.length,
      0,
    );
    expect(consumers).toBe(3);
    expect(
      documentOf(svg).querySelectorAll('[data-eventflow-edge="consumer"]'),
    ).toHaveLength(consumers);
  });

  it("connects consumer branches through one trunk and spine", () => {
    const layout = layoutOf(FAN_OUT);
    const row = layout.rows[0];
    const doc = documentOf(renderEventFlowToSvg(layout));
    const trunk = doc.querySelector(".fanout-trunk");
    const spine = doc.querySelector(".fanout-spine");
    const branches = Array.from(doc.querySelectorAll(".fanout-edge"));

    expect(trunk).not.toBeNull();
    expect(spine).not.toBeNull();
    expect(trunk?.getAttribute("x1")).toBe(
      (row.eventBox.x + row.eventBox.width).toFixed(2),
    );
    expect(trunk?.getAttribute("y1")).toBe(
      (row.eventBox.y + row.eventBox.height / 2).toFixed(2),
    );
    expect(branches).toHaveLength(row.consumers.length);
    expect(
      branches.every(
        (branch) => branch.getAttribute("x1") === spine?.getAttribute("x1"),
      ),
    ).toBe(true);
  });

  it("gives every fan-out edge an arrowhead that lands on the consumer box", () => {
    const layout = layoutOf(FAN_OUT);
    const svg = renderEventFlowToSvg(layout);
    const doc = documentOf(svg);
    const heads = doc.querySelectorAll(".eventflow-arrow");
    // One head per consumer edge, plus one onto the event box.
    expect(heads.length).toBe(layout.rows[0].consumers.length + 1);
  });

  it("draws the producer → channel → event path", () => {
    const layout = layoutOf(FAN_OUT);
    const svg = renderEventFlowToSvg(layout);
    expect(
      documentOf(svg).querySelectorAll(".eventflow-channel-chip"),
    ).toHaveLength(1);
  });
});

describe("renderEventFlowToSvg — declared but unproduced", () => {
  const DECLARED_ONLY = `event Lonely
service S
service C
C consumes Lonely
`;

  it("dashes the event box and shows a faint no-producer label", () => {
    const svg = renderEventFlowToSvg(layoutOf(DECLARED_ONLY));
    const doc = documentOf(svg);
    const declared = doc.querySelector(".eventflow-event--declared-only");
    expect(declared?.getAttribute("stroke-dasharray")).toBe("5 4");
    expect(doc.querySelector(".eventflow-no-producer")?.textContent).toBe(
      NO_PRODUCER_LABEL,
    );
  });

  it("does not draw a producer box for a declared-only row", () => {
    const svg = renderEventFlowToSvg(layoutOf(DECLARED_ONLY));
    expect(
      documentOf(svg).querySelectorAll(".eventflow-service--producer"),
    ).toHaveLength(0);
  });
});

describe("renderEventFlowToSvg — cycles", () => {
  it("marks a row whose order was not causal", () => {
    const svg = renderEventFlowToSvg(layoutOf(CYCLE));
    expect(svg).toContain(">cycle<");
    expect(
      documentOf(svg).querySelectorAll(".eventflow-cycle-tag").length,
    ).toBe(2);
  });

  it("omits the marker for an acyclic flow", () => {
    const svg = renderEventFlowToSvg(layoutOf(FAN_OUT));
    expect(svg).not.toContain(">cycle<");
  });
});

describe("renderEventFlowToSvg — theme and background", () => {
  it("defaults to the light theme", () => {
    const layout = layoutOf(FAN_OUT);
    expect(renderEventFlowToSvg(layout)).toBe(
      renderEventFlowToSvg(layout, { theme: "light" }),
    );
  });

  it("draws a different palette for the dark theme", () => {
    const layout = layoutOf(FAN_OUT);
    expect(renderEventFlowToSvg(layout, { theme: "dark" })).not.toBe(
      renderEventFlowToSvg(layout, { theme: "light" }),
    );
  });

  it("omits the background rectangle when transparent", () => {
    const layout = layoutOf(FAN_OUT);
    expect(renderEventFlowToSvg(layout)).toContain('<rect width="');
    expect(
      renderEventFlowToSvg(layout, { background: "transparent" }),
    ).not.toContain('<rect width="');
  });

  it("uses a literal background colour verbatim", () => {
    const svg = renderEventFlowToSvg(layoutOf(FAN_OUT), {
      background: "#123456",
    });
    expect(svg).toContain('fill="#123456"');
  });
});

describe("renderEventFlowToSvg — title", () => {
  it("renders the title by default and omits it on request", () => {
    const layout = layoutOf(FAN_OUT);
    const withTitle = renderEventFlowToSvg(layout);
    expect(withTitle).toContain(">Order Processing<");

    const without = renderEventFlowToSvg(layout, { includeTitle: false });
    expect(without).not.toContain("Order Processing");
    // Dropping the title does not change the canvas the layout reserved.
    expect(without).toContain(
      `viewBox="0 0 ${eventFlowCanvasSize(layout).width} ${eventFlowCanvasSize(layout).height}"`,
    );
  });
});

describe("eventFlowCanvasSize", () => {
  it("grows by the padding on every side", () => {
    const layout = layoutOf(FAN_OUT);
    const base = eventFlowCanvasSize(layout);
    const padded = eventFlowCanvasSize(layout, 10);
    expect(padded.width).toBe(base.width + 20);
    expect(padded.height).toBe(base.height + 20);
  });

  it("clamps a missing or negative padding to zero", () => {
    const layout = layoutOf(FAN_OUT);
    expect(eventFlowCanvasSize(layout, -5)).toEqual(
      eventFlowCanvasSize(layout),
    );
  });

  it("shifts the drawing when padding is rendered", () => {
    const layout = layoutOf(FAN_OUT);
    const padded = eventFlowCanvasSize(layout, 12);
    const svg = renderEventFlowToSvg(layout, { padding: 12 });
    expect(svg).toContain(`width="${padded.width}"`);
    expect(svg).toContain(`height="${padded.height}"`);
    expect(svg).toContain('transform="translate(12, 12)"');
  });

  it("keeps a sane minimum for an empty layout", () => {
    const empty = layoutFlow(projectEventFlowToFlowView({ statements: [] }));
    const size = eventFlowCanvasSize(empty);
    expect(size.width).toBe(EVENT_MARGIN_X * 2);
    expect(size.height).toBeGreaterThan(0);
  });
});
