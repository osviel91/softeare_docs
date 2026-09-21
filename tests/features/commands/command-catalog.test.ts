import { describe, expect, it } from "vitest";
import {
  COMMAND_CATALOG,
  COMMAND_CATEGORIES,
  availableCommands,
} from "../../../src/features/commands/command-catalog";

/** A stable fingerprint of a chord, for the uniqueness check. */
function fingerprint(binding: {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}): string {
  return [
    binding.key,
    binding.mod ? "mod" : "",
    binding.shift ? "shift" : "",
    binding.alt ? "alt" : "",
  ].join("|");
}

describe("command catalog", () => {
  it("gives every command an id, a label, a description and a category", () => {
    for (const spec of COMMAND_CATALOG) {
      expect(spec.id.length).toBeGreaterThan(0);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(10);
      expect(COMMAND_CATEGORIES).toContain(spec.category);
      expect(spec.binding.key.length).toBeGreaterThan(0);
    }
  });

  it("uses one id per command", () => {
    const ids = COMMAND_CATALOG.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not register one chord twice in an environment", () => {
    for (const environment of [
      { folderSupported: false, folderOpen: false },
      { folderSupported: true, folderOpen: false },
      { folderSupported: true, folderOpen: true },
    ]) {
      const seen = new Set<string>();
      for (const spec of availableCommands(environment)) {
        const key = fingerprint(spec.binding);
        expect(seen.has(key), `${spec.id} duplicates ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });

  it("offers Open Folder only when closed, and Close Folder only when open", () => {
    const unsupported = availableCommands({
      folderSupported: false,
      folderOpen: false,
    }).map((spec) => spec.id);
    expect(unsupported).not.toContain("open-folder");
    expect(unsupported).not.toContain("close-folder");

    const closed = availableCommands({
      folderSupported: true,
      folderOpen: false,
    }).map((spec) => spec.id);
    expect(closed).toContain("open-folder");
    expect(closed).not.toContain("close-folder");

    const opened = availableCommands({
      folderSupported: true,
      folderOpen: true,
    }).map((spec) => spec.id);
    expect(opened).toContain("close-folder");
    expect(opened).not.toContain("open-folder");
  });

  it("offers Documentation in every environment", () => {
    for (const environment of [
      { folderSupported: false, folderOpen: false },
      { folderSupported: true, folderOpen: true },
    ]) {
      expect(availableCommands(environment).map((spec) => spec.id)).toContain(
        "open-docs",
      );
    }
  });
});
