import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CommandPalette from "../../../src/features/commands/CommandPalette";
import { createCommandRegistry, type Command } from "../../../src/features/commands/command";

const commands: Command[] = [
  { id: "new-diagram", label: "New Diagram", execute: vi.fn() },
  { id: "close-tab", label: "Close Tab", execute: vi.fn() },
  { id: "open-folder", label: "Open Folder…", execute: vi.fn() },
];

function setup(overrides = {}) {
  const onRun = vi.fn();
  const onClose = vi.fn();
  const registry = createCommandRegistry(commands);
  render(
    <CommandPalette
      registry={registry}
      onRun={onRun}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onRun, onClose };
}

describe("CommandPalette", () => {
  it("shows all commands with an empty query", () => {
    setup();
    expect(screen.getAllByTestId("palette-item")).toHaveLength(3);
  });

  it("filters commands by the input text", () => {
    setup();
    const input = screen.getByTestId("palette-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "close" } });
    const items = screen.getAllByTestId("palette-item");
    expect(items).toHaveLength(1);
    expect(screen.getByLabelText("Close Tab")).toBeInTheDocument();
  });

  it("shows an empty hint when nothing matches", () => {
    setup();
    const input = screen.getByTestId("palette-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "nope" } });
    expect(screen.getByTestId("palette-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("palette-item")).toBeNull();
  });

  it("runs a command on click (delegating run + close to onRun)", () => {
    const { onRun } = setup();
    fireEvent.click(screen.getByLabelText("New Diagram"));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0][0].id).toBe("new-diagram");
  });

  it("runs the highlighted command on Enter", () => {
    const { onRun } = setup();
    const input = screen.getByTestId("palette-input");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0][0].id).toBe("new-diagram");
  });

  it("moves the selection with arrow keys and wraps at both ends", () => {
    setup();
    const buttons = () => screen.getAllByTestId("palette-item-button");
    const input = screen.getByTestId("palette-input");
    // First item is active by default.
    expect(buttons()[0]).toHaveClass("palette__item--active");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(buttons()[1]).toHaveClass("palette__item--active");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(buttons()[2]).toHaveClass("palette__item--active");

    // ArrowDown at the last wraps back to the first.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(buttons()[0]).toHaveClass("palette__item--active");

    // ArrowUp at the first wraps back to the last.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(buttons()[2]).toHaveClass("palette__item--active");
  });

  it("closes on Escape", () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is clicked", () => {
    const { onClose } = setup();
    const overlay = screen.getByTestId("command-palette") as HTMLElement;
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the panel is clicked", () => {
    const { onClose } = setup();
    fireEvent.mouseDown(screen.getByTestId("palette-input"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
