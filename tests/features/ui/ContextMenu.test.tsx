import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ContextMenu, {
  clampMenuToViewport,
  VIEWPORT_MARGIN,
} from "../../../src/features/ui/ContextMenu";

/** The menu items the explorer builds for a file. */
function items(onSelect = vi.fn()) {
  return [
    { id: "rename", label: "Rename…", onSelect },
    { id: "title", label: "Change title…", onSelect: vi.fn() },
    { id: "delete", label: "Delete", onSelect: vi.fn(), danger: true },
  ];
}

describe("ContextMenu", () => {
  it("renders its items at the given position", () => {
    render(<ContextMenu x={40} y={80} items={items()} onClose={vi.fn()} />);
    const menu = screen.getByTestId("context-menu");
    expect(menu).toHaveStyle({ left: "40px", top: "80px" });
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("runs an item's action and closes", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu x={0} y={0} items={items(onSelect)} onClose={onClose} />,
    );
    fireEvent.click(screen.getByTestId("context-menu-rename"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape without choosing anything", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu x={0} y={0} items={items(onSelect)} onClose={onClose} />,
    );
    fireEvent.keyDown(screen.getByTestId("context-menu"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes on a pointer press outside the menu", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items()} onClose={onClose} />);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open when the press lands inside the menu", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items()} onClose={onClose} />);
    fireEvent.pointerDown(screen.getByTestId("context-menu"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays mounted while the page scrolls before an item click", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items()} onClose={onClose} />);
    fireEvent.scroll(window);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("context-menu-title")).toBeInTheDocument();
  });

  it("marks a destructive item", () => {
    render(<ContextMenu x={0} y={0} items={items()} onClose={vi.fn()} />);
    expect(screen.getByTestId("context-menu-delete")).toHaveClass(
      "context-menu__item--danger",
    );
  });
});

/**
 * A fixed-position menu anchored near a viewport edge used to draw its own items
 * off-screen, where they could neither be read nor clicked. The regression the
 * E2E suite caught was exactly that: the third item of the "add to project" menu
 * sat below the fold on a long explorer and no click could reach it.
 */
describe("ContextMenu viewport clamping", () => {
  const viewport = { width: 1000, height: 800 };
  const menu = { width: 168, height: 120 };

  it("leaves a menu that already fits where it was asked to appear", () => {
    expect(clampMenuToViewport({ x: 40, y: 80 }, menu, viewport)).toEqual({
      x: 40,
      y: 80,
    });
  });

  it("pulls a menu back from the bottom edge", () => {
    // The anchor is below the viewport, as it is for a button at the end of a
    // long list: the menu must move up until its last item is reachable.
    const placed = clampMenuToViewport({ x: 40, y: 790 }, menu, viewport);
    expect(placed.y + menu.height).toBeLessThanOrEqual(
      viewport.height - VIEWPORT_MARGIN,
    );
    expect(placed.y).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  });

  it("pulls a menu back from the right edge", () => {
    const placed = clampMenuToViewport({ x: 980, y: 80 }, menu, viewport);
    expect(placed.x + menu.width).toBeLessThanOrEqual(
      viewport.width - VIEWPORT_MARGIN,
    );
  });

  it("pins an oversized menu to the near margin, where its first items are", () => {
    const placed = clampMenuToViewport(
      { x: 500, y: 700 },
      { width: 2000, height: 2000 },
      viewport,
    );
    expect(placed).toEqual({ x: VIEWPORT_MARGIN, y: VIEWPORT_MARGIN });
  });
});
