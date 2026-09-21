import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderHook } from "@testing-library/react";
import {
  createCommandRegistry,
  type Command,
} from "../../../src/features/commands/command";
import { useShortcuts } from "../../../src/features/commands/use-shortcuts";

/** A registry of one command with the given binding. */
function registryWith(command: Command) {
  return createCommandRegistry([command]);
}

describe("useShortcuts", () => {
  it("runs the command whose chord is pressed", () => {
    const execute = vi.fn();
    const registry = registryWith({
      id: "new-diagram",
      label: "New Diagram",
      binding: { key: "n", mod: true, alt: true },
      execute,
    });
    renderHook(() => useShortcuts(registry));

    fireEvent.keyDown(document, { key: "n", ctrlKey: true, altKey: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("ignores a command without a binding", () => {
    const execute = vi.fn();
    const registry = registryWith({
      id: "no-shortcut",
      label: "No Shortcut",
      execute,
    });
    renderHook(() => useShortcuts(registry));

    fireEvent.keyDown(document, { key: "n", ctrlKey: true, altKey: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not fire while disabled", () => {
    const execute = vi.fn();
    const registry = registryWith({
      id: "new-diagram",
      label: "New Diagram",
      binding: { key: "n", mod: true, alt: true },
      execute,
    });
    renderHook(() => useShortcuts(registry, false));

    fireEvent.keyDown(document, { key: "n", ctrlKey: true, altKey: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("lets a focused text field keep a plain function key", () => {
    const execute = vi.fn();
    const registry = registryWith({
      id: "rename-symbol",
      label: "Rename Symbol…",
      binding: { key: "f2" },
      execute,
    });
    renderHook(() => useShortcuts(registry));

    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "F2" });
    expect(execute).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("still honours a modified chord typed inside a text field", () => {
    const execute = vi.fn();
    const registry = registryWith({
      id: "new-diagram",
      label: "New Diagram",
      binding: { key: "n", mod: true, alt: true },
      execute,
    });
    renderHook(() => useShortcuts(registry));

    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "n", ctrlKey: true, altKey: true });
    expect(execute).toHaveBeenCalledTimes(1);
    document.body.removeChild(input);
  });

  it("stops listening when unmounted", () => {
    const execute = vi.fn();
    const registry = registryWith({
      id: "new-diagram",
      label: "New Diagram",
      binding: { key: "n", mod: true, alt: true },
      execute,
    });
    const { unmount } = renderHook(() => useShortcuts(registry));
    unmount();

    fireEvent.keyDown(document, { key: "n", ctrlKey: true, altKey: true });
    expect(execute).not.toHaveBeenCalled();
  });
});
