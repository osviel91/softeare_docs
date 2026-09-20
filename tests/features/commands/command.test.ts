import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry, type Command } from "../../../src/features/commands/command";

/** A command whose `execute` records calls, so tests can assert on it. */
function command(id: string, label: string, executed?: ReturnType<typeof vi.fn>): Command {
  return { id, label, execute: executed ?? vi.fn() };
}

describe("createCommandRegistry", () => {
  it("exposes the commands in registration order", () => {
    const a = command("a", "Alpha");
    const b = command("b", "Beta");
    const registry = createCommandRegistry([a, b]);
    expect(registry.commands).toEqual([a, b]);
  });

  it("returns every command for an empty or blank query", () => {
    const registry = createCommandRegistry([command("a", "New Diagram"), command("b", "Close Tab")]);
    expect(registry.filter("")).toEqual([
      expect.objectContaining({ id: "a" }),
      expect.objectContaining({ id: "b" }),
    ]);
    expect(registry.filter("   ")).toHaveLength(2);
  });

  it("filters by case-insensitive substring of the label", () => {
    const registry = createCommandRegistry([
      command("a", "New Diagram"),
      command("b", "Close Tab"),
    ]);

    expect(registry.filter("new").map((c) => c.id)).toEqual(["a"]);
    expect(registry.filter("tab").map((c) => c.id)).toEqual(["b"]);
    expect(registry.filter("DIAGRAM").map((c) => c.id)).toEqual(["a"]);
  });

  it("returns no commands when nothing matches", () => {
    const registry = createCommandRegistry([command("a", "New Diagram")]);
    expect(registry.filter("zzz")).toEqual([]);
  });

  it("runs a registered command and reports success", () => {
    const executed = vi.fn();
    const registry = createCommandRegistry([command("a", "New Diagram", executed)]);
    expect(registry.run("a")).toBe(true);
    expect(executed).toHaveBeenCalledTimes(1);
  });

  it("runs nothing and reports failure for an unknown id", () => {
    const executed = vi.fn();
    const registry = createCommandRegistry([command("a", "New Diagram", executed)]);
    expect(registry.run("missing")).toBe(false);
    expect(executed).not.toHaveBeenCalled();
  });
});
