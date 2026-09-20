import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ContextMenu from "../../../src/features/ui/ContextMenu";

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

  it("marks a destructive item", () => {
    render(<ContextMenu x={0} y={0} items={items()} onClose={vi.fn()} />);
    expect(screen.getByTestId("context-menu-delete")).toHaveClass(
      "context-menu__item--danger",
    );
  });
});
