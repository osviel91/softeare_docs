import { describe, expect, it } from "vitest";
import {
  bindingLabel,
  bindingMatches,
  type KeyBinding,
} from "../../../src/features/commands/shortcuts";

/** A keydown-like object with just the fields a binding looks at. */
function chordEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("bindingMatches", () => {
  it("requires the key and every declared modifier to be present", () => {
    const binding: KeyBinding = { key: "p", mod: true, shift: true };
    expect(
      bindingMatches(
        binding,
        chordEvent({ key: "P", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
    expect(
      bindingMatches(
        binding,
        chordEvent({ key: "p", metaKey: true, shiftKey: true }),
      ),
    ).toBe(true);
  });

  it("rejects a chord with an extra or missing modifier", () => {
    const binding: KeyBinding = { key: "p", mod: true };
    expect(
      bindingMatches(binding, chordEvent({ key: "p", ctrlKey: true })),
    ).toBe(true);
    expect(
      bindingMatches(
        binding,
        chordEvent({ key: "p", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    expect(
      bindingMatches(
        binding,
        chordEvent({ key: "p", ctrlKey: true, altKey: true }),
      ),
    ).toBe(false);
    expect(bindingMatches(binding, chordEvent({ key: "p" }))).toBe(false);
  });

  it("matches a plain function key with no modifiers at all", () => {
    expect(bindingMatches({ key: "f2" }, chordEvent({ key: "F2" }))).toBe(true);
    expect(
      bindingMatches({ key: "f2" }, chordEvent({ key: "F2", ctrlKey: true })),
    ).toBe(false);
  });
});

describe("bindingLabel", () => {
  it("writes a Mac chord with glyphs", () => {
    expect(bindingLabel({ key: "p", mod: true, shift: true }, true)).toBe(
      "⌘⇧P",
    );
  });

  it("writes a non-Mac chord with named modifiers", () => {
    expect(bindingLabel({ key: "p", mod: true, shift: true }, false)).toBe(
      "Ctrl+Shift+P",
    );
  });

  it("includes Alt/Option and uppercases function keys", () => {
    expect(bindingLabel({ key: "n", mod: true, alt: true }, false)).toBe(
      "Ctrl+Alt+N",
    );
    expect(bindingLabel({ key: "f2" }, true)).toBe("F2");
    expect(
      bindingLabel({ key: "c", mod: true, alt: true, shift: true }, true),
    ).toBe("⌘⌥⇧C");
  });
});
