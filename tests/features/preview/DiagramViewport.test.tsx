import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import DiagramViewport, {
  noteIndexFromTarget,
  participantDragName,
} from "../../../src/features/preview/DiagramViewport";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><text>Hi</text></svg>';
const SIZE = { width: 400, height: 300 };

/** jsdom reports every element as 0x0; give the pane a real box. */
function stubPaneSize(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/** The transform applied to the diagram content. */
function transformOf(): string {
  return screen.getByTestId("viewport-content").style.transform;
}

describe("DiagramViewport", () => {
  beforeEach(() => stubPaneSize(800, 600));
  afterEach(() => vi.restoreAllMocks());

  it("renders the supplied svg markup", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    expect(screen.getByTestId("viewport-content").innerHTML).toContain("<svg");
  });

  it("activates bound semantic badges without starting a pan", () => {
    const onSemanticMessageSelect = vi.fn();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<g data-node-id="message:1"><text class="semantic-message-badge" data-semantic-message-id="msg-1" tabindex="0" role="button">EVENT · publish</text></g></svg>';
    render(
      <DiagramViewport
        svg={svg}
        size={SIZE}
        onSemanticMessageSelect={onSemanticMessageSelect}
      />,
    );
    const badge = document.querySelector(".semantic-message-badge")!;
    fireEvent.pointerDown(badge, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(badge);
    expect(onSemanticMessageSelect).toHaveBeenCalledWith("msg-1", "message:1");
    expect(screen.getByTestId("viewport-pane")).not.toHaveClass("viewport__pane--panning");
    fireEvent.keyDown(badge, { key: "Enter" });
    fireEvent.keyDown(badge, { key: " " });
    expect(onSemanticMessageSelect).toHaveBeenCalledTimes(3);
  });

  it("highlights every current-resource occurrence by identity", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<g data-node-id="message:1" data-semantic-message-id="msg-1"><text data-semantic-message-id="msg-1">EVENT · publish</text></g>' +
      '<g data-node-id="message:2" data-semantic-message-id="msg-1"><text data-semantic-message-id="msg-1">EVENT · consume</text></g>' +
      '<g data-node-id="message:3" data-semantic-message-id="other"><text data-semantic-message-id="other">EVENT · publish</text></g></svg>';
    render(<DiagramViewport svg={svg} size={SIZE} activeSemanticMessageId="msg-1" />);
    expect(document.querySelectorAll(".semantic-message--active")).toHaveLength(4);
    expect(document.querySelector('[data-semantic-message-id="other"]')).not.toHaveClass(
      "semantic-message--active",
    );
  });

  it.each(["EVENT · consume", "COMMAND · dispatch"])(
    "activates an unbound semantic badge through node selection: %s",
    (label) => {
      const onNodeSelect = vi.fn();
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">` +
        `<g data-node-id="message:1"><text class="semantic-message-badge" data-semantic-message-name="Message" tabindex="0" role="button">${label}</text></g></svg>`;
      render(<DiagramViewport svg={svg} size={SIZE} onNodeSelect={onNodeSelect} />);
      const badge = document.querySelector(".semantic-message-badge")!;
      fireEvent.click(badge);
      expect(onNodeSelect).toHaveBeenCalledWith("message:1");
      fireEvent.keyDown(badge, { key: "Enter" });
      fireEvent.keyDown(badge, { key: " " });
      expect(onNodeSelect).toHaveBeenCalledTimes(3);
    },
  );

  it("honours a caller-supplied test id for the svg element", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} svgTestId="preview-svg" />);
    expect(screen.getByTestId("preview-svg").innerHTML).toContain("<svg");
  });

  it("fits the diagram on mount", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    // A diagram smaller than the pane is shown at natural size, centered.
    expect(screen.getByTestId("zoom-level").textContent).toBe("100%");
    expect(transformOf()).toContain("translate(200px, 150px)");
  });

  it("zooms in and out by one step", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    fireEvent.click(screen.getByTestId("zoom-in"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");
    fireEvent.click(screen.getByTestId("zoom-out"));
    fireEvent.click(screen.getByTestId("zoom-out"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("80%");
  });

  it("returns to 100% on reset", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    fireEvent.click(screen.getByTestId("zoom-in"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");
    fireEvent.click(screen.getByTestId("zoom-reset"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("100%");
  });

  it("shrinks a diagram larger than the pane when fitting", () => {
    render(<DiagramViewport svg={SVG} size={{ width: 4000, height: 3000 }} />);
    // (800 - 64) / 4000 = 0.184
    expect(screen.getByTestId("zoom-level").textContent).toBe("18%");
  });

  it("pans with the arrow keys", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    const before = transformOf();
    fireEvent.keyDown(screen.getByTestId("viewport-pane"), {
      key: "ArrowRight",
    });
    expect(transformOf()).not.toBe(before);
    expect(transformOf()).toContain("translate(152px, 150px)");
  });

  it("ignores keys it does not handle", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    const before = transformOf();
    fireEvent.keyDown(screen.getByTestId("viewport-pane"), { key: "a" });
    expect(transformOf()).toBe(before);
  });

  it("re-fits when the reset key changes", () => {
    const { rerender } = render(
      <DiagramViewport svg={SVG} size={SIZE} resetKey="one" />,
    );
    fireEvent.click(screen.getByTestId("zoom-in"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");
    rerender(<DiagramViewport svg={SVG} size={SIZE} resetKey="two" />);
    expect(screen.getByTestId("zoom-level").textContent).toBe("100%");
  });

  it("renders a minimap image and a viewport indicator", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    const image = screen.getByTestId("minimap-image") as HTMLImageElement;
    // The minimap embeds the same svg as an image so labels are not duplicated
    // in the document.
    expect(decodeURIComponent(image.src)).toContain("<svg");
    expect(screen.getByTestId("minimap-view")).toBeInTheDocument();
  });

  it("exposes the zoom controls as labelled buttons", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    expect(screen.getByLabelText("Zoom in")).toBeInTheDocument();
    expect(screen.getByLabelText("Zoom out")).toBeInTheDocument();
    expect(screen.getByLabelText("Fit diagram to view")).toBeInTheDocument();
    expect(screen.getByLabelText("Reset zoom to 100%")).toBeInTheDocument();
    expect(screen.getByLabelText("Present fullscreen")).toBeInTheDocument();
  });

  it("toggles the preview-only layout when the caller provides it", () => {
    const onToggleMaximize = vi.fn();
    render(
      <DiagramViewport
        svg={SVG}
        size={SIZE}
        onToggleMaximize={onToggleMaximize}
      />,
    );

    fireEvent.click(screen.getByLabelText("Maximize diagram preview"));

    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
  });

  describe("note bullets", () => {
    // A bullet inside the injected markup, as the renderer emits it.
    const SVG_WITH_NOTE =
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<g data-note-index="0" role="button" tabindex="0" aria-label="Note: hi">' +
      '<circle cx="10" cy="10" r="6"/></g></svg>';

    it("reports a bullet activation by index", () => {
      const onNoteToggle = vi.fn();
      render(
        <DiagramViewport
          svg={SVG_WITH_NOTE}
          size={SIZE}
          onNoteToggle={onNoteToggle}
        />,
      );
      fireEvent.click(document.querySelector('[data-note-index="0"]')!);
      expect(onNoteToggle).toHaveBeenCalledWith(0);
    });

    it("finds the index from a bullet or any of its children", () => {
      render(<DiagramViewport svg={SVG_WITH_NOTE} size={SIZE} />);
      const bullet = document.querySelector('[data-note-index="0"]')!;
      const circle = bullet.querySelector("circle")!;
      expect(noteIndexFromTarget(bullet)).toBe(0);
      // Clicks land on the drawn circle, inside the bullet group.
      expect(noteIndexFromTarget(circle)).toBe(0);
    });

    it("returns null for targets outside a bullet", () => {
      render(<DiagramViewport svg={SVG_WITH_NOTE} size={SIZE} />);
      expect(
        noteIndexFromTarget(screen.getByTestId("viewport-pane")),
      ).toBeNull();
      expect(noteIndexFromTarget(null)).toBeNull();
    });

    it("ignores clicks that are not on a bullet", () => {
      const onNoteToggle = vi.fn();
      render(
        <DiagramViewport
          svg={SVG_WITH_NOTE}
          size={SIZE}
          onNoteToggle={onNoteToggle}
        />,
      );
      fireEvent.click(screen.getByTestId("viewport-pane"));
      expect(onNoteToggle).not.toHaveBeenCalled();
    });
  });
});

describe("DiagramViewport — linked camera", () => {
  beforeEach(() => stubPaneSize(800, 600));
  afterEach(() => vi.restoreAllMocks());

  it("ignores a fresh size object with the same numbers while linked", () => {
    const onTransformChange = vi.fn();
    const { rerender } = render(
      <DiagramViewport
        svg={SVG}
        size={{ width: 400, height: 300 }}
        onTransformChange={onTransformChange}
      />,
    );
    onTransformChange.mockClear();

    // A caller that passes a new `{ width, height }` literal each render must
    // not re-fit (and, while linked, must not echo a camera on every render).
    rerender(
      <DiagramViewport
        svg={SVG}
        size={{ width: 400, height: 300 }}
        onTransformChange={onTransformChange}
      />,
    );
    rerender(
      <DiagramViewport
        svg={SVG}
        size={{ width: 400, height: 300 }}
        onTransformChange={onTransformChange}
      />,
    );

    expect(onTransformChange).not.toHaveBeenCalled();
  });

  it("adopts a linked transform without reporting it back to the parent", () => {
    const onTransformChange = vi.fn();
    const { rerender } = render(
      <DiagramViewport
        svg={SVG}
        size={SIZE}
        onTransformChange={onTransformChange}
      />,
    );
    onTransformChange.mockClear();

    rerender(
      <DiagramViewport
        svg={SVG}
        size={SIZE}
        linkedTransform={{ x: 10, y: 20, scale: 1.5 }}
        onTransformChange={onTransformChange}
      />,
    );

    expect(transformOf()).toContain("translate(10px, 20px)");
    expect(transformOf()).toContain("scale(1.5)");
    // Following the peer is not the same as moving: no echo back to the source.
    expect(onTransformChange).not.toHaveBeenCalled();
  });

  it("does not reset the camera when the report callback appears or disappears", () => {
    const onTransformChange = vi.fn();
    const { rerender } = render(<DiagramViewport svg={SVG} size={SIZE} />);
    fireEvent.click(screen.getByTestId("zoom-in"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");

    // Linking toggles the callback on; that alone must not re-fit the pane.
    rerender(
      <DiagramViewport
        svg={SVG}
        size={SIZE}
        onTransformChange={onTransformChange}
      />,
    );
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");

    // Unlinking removes it; the camera must survive too.
    rerender(<DiagramViewport svg={SVG} size={SIZE} />);
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");
  });
});

describe("DiagramViewport — dragging a participant", () => {
  // A participant group as the renderer emits it.
  const SVG_WITH_PARTICIPANT =
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
    '<g data-participant-id="API" data-participant-label="API" draggable="true">' +
    '<rect x="0" y="0" width="20" height="20"/></g></svg>';

  beforeEach(() => stubPaneSize(800, 600));
  afterEach(() => vi.restoreAllMocks());

  it("recognizes a participant group as a drag source", () => {
    render(<DiagramViewport svg={SVG_WITH_PARTICIPANT} size={SIZE} />);
    expect(
      participantDragName(
        document.querySelector('[data-participant-id="API"]'),
      ),
    ).toBe("API");
    expect(participantDragName(screen.getByTestId("viewport-pane"))).toBeNull();
  });

  it("puts the participant name on the drag payload as plain text", () => {
    render(<DiagramViewport svg={SVG_WITH_PARTICIPANT} size={SIZE} />);
    const setData = vi.fn();
    fireEvent.dragStart(
      document.querySelector('[data-participant-id="API"]')!,
      { dataTransfer: { setData, effectAllowed: "" } },
    );
    expect(setData).toHaveBeenCalledWith("text/plain", "API");
  });
});
