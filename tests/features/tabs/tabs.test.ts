import { describe, expect, it } from "vitest";
import type {
  DiagramFile,
  NoteFile,
} from "../../../src/domain/workspace/types";
import {
  activateTab,
  closeTab,
  createEmptyTabSet,
  documentTitle,
  getActiveTab,
  hasTab,
  isDirty,
  markTabSaved,
  openDiagram,
  openNote,
  tabDocumentOfDiagram,
  tabDocumentOfNote,
  updateTabSource,
  type TabSet,
} from "../../../src/features/tabs/tabs";

const diagram = (
  id: string,
  source = `title ${id}\nA -> B: hi`,
  name?: string,
): DiagramFile => ({
  id,
  name: name ?? id,
  source,
  projectId: "proj-1",
});

const note = (
  id: string,
  markdown = `# ${id}\n\nProse.`,
  name?: string,
): NoteFile => ({
  id,
  name: name ?? `${id}.md`,
  markdown,
  projectId: "proj-1",
});

const empty = (): TabSet => createEmptyTabSet();

describe("tab-set model", () => {
  it("starts empty with no active tab", () => {
    const set = empty();
    expect(set.tabs).toEqual([]);
    expect(set.activeTabId).toBeNull();
    expect(getActiveTab(set)).toBeNull();
  });

  it("opens a new diagram as the active tab", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    expect(set.tabs).toHaveLength(1);
    expect(set.activeTabId).toBe("diag-1");
    expect(set.tabs[0].kind).toBe("diagram");
    expect(getActiveTab(set)?.source).toBe(diagram("diag-1").source);
  });

  it("labels an opened tab with the title from its source", () => {
    const set = openDiagram(
      empty(),
      diagram("diag-1", "title Report\nA -> B: hi", "report.seq"),
    );
    const tab = getActiveTab(set);
    expect(tab?.title).toBe("Report");
    // The backing file name is kept for persistence, not shown.
    expect(tab?.name).toBe("report.seq");
  });

  it("falls back to the file name when the source has no title", () => {
    const set = openDiagram(
      empty(),
      diagram("diag-1", "participant A", "untitled.seq"),
    );
    expect(getActiveTab(set)?.title).toBe("untitled.seq");
  });

  it("opens a markdown note in the same tab strip, labelled by its heading", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    const withNote = openNote(
      set,
      note("note-1", "# Architecture\n\nProse.", "design.md"),
    );
    expect(withNote.tabs).toHaveLength(2);
    expect(withNote.activeTabId).toBe("note-1");
    const tab = getActiveTab(withNote);
    expect(tab?.kind).toBe("note");
    // A note's heading names the tab, exactly as a diagram's `title` does.
    expect(tab?.title).toBe("Architecture");
    expect(tab?.name).toBe("design.md");
  });

  it("falls back to the file name when a note has no heading", () => {
    const set = openNote(empty(), note("note-1", "Just prose.", "runbook.md"));
    expect(getActiveTab(set)?.title).toBe("runbook");
  });

  it("derives a title per kind through documentTitle", () => {
    expect(documentTitle("diagram", "a.seq", "title Named\nA -> B: hi")).toBe(
      "Named",
    );
    expect(documentTitle("note", "a.md", "# Named")).toBe("Named");
  });

  it("treats a freshly opened tab as saved", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    const tab = getActiveTab(set);
    expect(tab && isDirty(tab)).toBe(false);
    expect(tab?.savedSource).toBe(tab?.source);
  });

  it("re-derives the tab title when the title line is edited", () => {
    let set = openDiagram(empty(), diagram("diag-1", "title First"));
    set = updateTabSource(set, "diag-1", "title Second\nparticipant A");
    expect(getActiveTab(set)?.title).toBe("Second");
    expect(getActiveTab(set)?.name).toBe("diag-1");
  });

  it("marks a tab dirty when its buffer diverges from the saved content", () => {
    let set = openDiagram(empty(), diagram("diag-1"));
    set = updateTabSource(set, "diag-1", "participant A");
    expect(isDirty(getActiveTab(set)!)).toBe(true);
  });

  it("re-derives a note's title from its heading as the user types", () => {
    let set = openNote(empty(), note("note-1", "# First"));
    set = updateTabSource(set, "note-1", "# Second\n\nBody.");
    expect(getActiveTab(set)?.title).toBe("Second");
  });

  it("clears the dirty flag when the written buffer is recorded", () => {
    let set = openDiagram(empty(), diagram("diag-1"));
    set = updateTabSource(set, "diag-1", "participant A");
    set = markTabSaved(set, "diag-1", "participant A");
    expect(isDirty(getActiveTab(set)!)).toBe(false);

    // A save that only recorded an older buffer leaves the newer edit dirty.
    set = updateTabSource(set, "diag-1", "participant B");
    set = markTabSaved(set, "diag-1", "participant A");
    expect(isDirty(getActiveTab(set)!)).toBe(true);
  });

  it("reverts to the file name when the title is removed", () => {
    let set = openDiagram(
      empty(),
      diagram("diag-1", "title Named", "file.seq"),
    );
    set = updateTabSource(set, "diag-1", "participant A");
    expect(getActiveTab(set)?.title).toBe("file.seq");
  });

  it("activates an already-open tab without duplicating it", () => {
    let set = openDiagram(empty(), diagram("diag-1"));
    set = openDiagram(set, diagram("diag-2"));
    set = openDiagram(set, diagram("diag-1"));
    expect(set.tabs).toHaveLength(2);
    expect(set.activeTabId).toBe("diag-1");
  });

  it("reports whether a document is open", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    expect(hasTab(set, "diag-1")).toBe(true);
    expect(hasTab(set, "diag-2")).toBe(false);
  });

  it("activates an open tab", () => {
    let set = openDiagram(empty(), diagram("diag-1"));
    set = openDiagram(set, diagram("diag-2"));
    set = activateTab(set, "diag-1");
    expect(set.activeTabId).toBe("diag-1");
  });

  it("does not activate a document that is not open", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    const next = activateTab(set, "diag-2");
    expect(next).toBe(set);
    expect(next.activeTabId).toBe("diag-1");
  });

  it("replaces the active tab's buffer on source update", () => {
    let set = openDiagram(empty(), diagram("diag-1"));
    set = updateTabSource(set, "diag-1", "participant A");
    expect(getActiveTab(set)?.source).toBe("participant A");
  });

  it("ignores source updates for an unknown tab", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    const next = updateTabSource(set, "diag-2", "x");
    expect(next).toBe(set);
  });

  it("closes the active tab and switches to the previous one", () => {
    let set = openDiagram(empty(), diagram("diag-1"));
    set = openDiagram(set, diagram("diag-2"));
    set = openDiagram(set, diagram("diag-3"));
    // Close diag-3: the previous tab (diag-2) becomes active.
    set = closeTab(set, "diag-3");
    expect(getActiveTab(set)?.id).toBe("diag-2");
    expect(hasTab(set, "diag-3")).toBe(false);
  });

  it("closes the active tab and falls back to the first when no previous exists", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    const next = closeTab(set, "diag-1");
    expect(next.activeTabId).toBeNull();
    expect(next.tabs).toHaveLength(0);
  });

  it("keeps the active tab unchanged when a non-active tab is closed", () => {
    let set = openDiagram(empty(), diagram("diag-1"));
    set = openDiagram(set, diagram("diag-2"));
    set = closeTab(set, "diag-1");
    expect(getActiveTab(set)?.id).toBe("diag-2");
  });

  it("ignores closing an unknown tab", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    const next = closeTab(set, "diag-9");
    expect(next).toBe(set);
  });
});

describe("tab documents", () => {
  it("projects a diagram file onto a tab document", () => {
    expect(
      tabDocumentOfDiagram(diagram("diag-1", "title T\nA -> B: hi", "a.seq")),
    ).toEqual({
      kind: "diagram",
      id: "diag-1",
      projectId: "proj-1",
      name: "a.seq",
      source: "title T\nA -> B: hi",
    });
  });

  it("projects a note onto a tab document, carrying its markdown as source", () => {
    expect(tabDocumentOfNote(note("note-1", "# Hi", "a.md"))).toEqual({
      kind: "note",
      id: "note-1",
      projectId: "proj-1",
      name: "a.md",
      source: "# Hi",
    });
  });
});
