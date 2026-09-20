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
