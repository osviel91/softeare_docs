import { describe, expect, it } from "vitest";
import {
  noteDisplayName,
  noteHeadings,
  noteTitle,
  withNoteTitle,
} from "../../../src/language/markdown/note-title";

describe("noteTitle", () => {
  it("returns the first level-1 heading", () => {
    expect(noteTitle("# Architecture\n\ntext")).toBe("Architecture");
  });

  it("ignores deeper headings", () => {
    expect(noteTitle("## Section\n\n# Real title")).toBe("Real title");
  });

  it("returns undefined when there is no level-1 heading", () => {
    expect(noteTitle("just prose")).toBeUndefined();
    expect(noteTitle("")).toBeUndefined();
  });

  it("ignores an empty heading", () => {
    expect(noteTitle("# \n\n# Later")).toBe("Later");
  });
});

describe("noteDisplayName", () => {
  it("prefers the heading", () => {
    expect(noteDisplayName("readme.md", "# Onboarding\n")).toBe("Onboarding");
  });

  it("falls back to the file name without its extension", () => {
    expect(noteDisplayName("design-notes.md", "no heading")).toBe(
      "design-notes",
    );
  });

  it("falls back to Untitled for an empty name", () => {
    expect(noteDisplayName(".md", "")).toBe("Untitled");
  });
});

describe("withNoteTitle", () => {
  it("replaces an existing heading in place", () => {
    expect(withNoteTitle("# Old\n\nbody", "New")).toBe("# New\n\nbody");
  });

  it("prepends a heading when there is none", () => {
    expect(withNoteTitle("body", "New")).toBe("# New\n\nbody");
  });

  it("prepends into an empty note", () => {
    expect(withNoteTitle("", "New")).toBe("# New\n\n");
  });

  it("removes the heading when the title is blank", () => {
    expect(withNoteTitle("# Old\n\nbody", "   ")).toBe("body");
  });

  it("leaves the document alone when clearing a title it does not have", () => {
    expect(withNoteTitle("body", "")).toBe("body");
  });
});

describe("noteHeadings", () => {
  it("lists headings with their levels", () => {
    expect(noteHeadings("# One\n\n## Two\n\ntext")).toEqual([
      { level: 1, text: "One" },
      { level: 2, text: "Two" },
    ]);
  });
});
