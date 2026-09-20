import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  tabDocumentOfDiagram,
  tabDocumentOfNote,
  type TabDocument,
} from "../../../src/features/tabs/tabs";
import { useTabs } from "../../../src/features/tabs/use-tabs";
import type {
  DiagramFile,
  NoteFile,
} from "../../../src/domain/workspace/types";
import { createInMemoryWorkspaceRepository } from "../../../src/workspace/in-memory";

/** Seed a project with two diagrams and a note so the hook wraps real files. */
async function seedRepo() {
  const repo = createInMemoryWorkspaceRepository();
  await repo.createProject("Alpha");
  await repo.saveDiagramFile("proj-0", diag1);
  await repo.saveDiagramFile("proj-0", diag2);
  await repo.saveNoteFile("proj-0", note1);
  return repo;
}

const diag1: DiagramFile = {
  id: "diag-1",
  name: "Welcome",
  source: "title Welcome\nA -> B: hi",
  projectId: "proj-0",
};

const diag2: DiagramFile = {
  id: "diag-2",
  name: "Flow",
  source: "title Flow\nX -> Y: bye",
  projectId: "proj-0",
};

const note1: NoteFile = {
  id: "note-1",
  name: "Overview.md",
  markdown: "# Overview\n\nProse.",
  projectId: "proj-0",
};

const doc1 = tabDocumentOfDiagram(diag1);
const doc2 = tabDocumentOfDiagram(diag2);
const noteDoc = tabDocumentOfNote(note1);

describe("useTabs", () => {
  it("opens the selected diagram into a tab with its source", async () => {
    const repo = await seedRepo();
    const { result, rerender } = renderHook(
      ({ selectedDocument }) => useTabs(repo, selectedDocument),
      {
        initialProps: { selectedDocument: null } as {
          selectedDocument: TabDocument | null;
        },
      },
    );

    // No document selected yet: no tab, editor falls back to the seeded sample.
    expect(result.current.tabs).toHaveLength(0);

    await act(async () => {
      rerender({ selectedDocument: doc1 });
    });
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTabId).toBe("diag-1");
    expect(result.current.activeTab?.kind).toBe("diagram");
    expect(result.current.source).toBe(diag1.source);
  });

  it("updates the editor source when editing with no tab open", async () => {
    const repo = await seedRepo();
    const saveSpy = vi.spyOn(repo, "saveDiagramFile");
    const { result } = renderHook(() => useTabs(repo, null));

    // No document loaded: editing still drives the editor source (and preview).
    await act(async () => {
      result.current.updateActiveSource(
        "participant Widget\nWidget -> Widget: hi",
      );
    });
    expect(result.current.source).toBe(
      "participant Widget\nWidget -> Widget: hi",
    );
    // Nothing was persisted because no tab is open to save into.
    await act(async () => {});
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("auto-saves edits through the active tab's project and id", async () => {
    const repo = await seedRepo();
    const saveSpy = vi.spyOn(repo, "saveDiagramFile");
    const { result } = renderHook(() => useTabs(repo, doc1));

    await act(async () => {
      result.current.updateActiveSource("participant A\nA -> B: edited");
    });

    expect(saveSpy).toHaveBeenCalledWith("proj-0", {
      id: "diag-1",
      name: "Welcome",
      source: "participant A\nA -> B: edited",
      projectId: "proj-0",
    });
    // The buffer reflects the edit even before any re-render.
    expect(result.current.source).toBe("participant A\nA -> B: edited");
  });

  it("marks the tab clean again once the write lands", async () => {
    const repo = await seedRepo();
    const { result } = renderHook(() => useTabs(repo, doc1));

    await act(async () => {
      result.current.updateActiveSource("participant A");
    });
    await act(async () => {});
    expect(result.current.tabs[0].savedSource).toBe("participant A");
    expect(result.current.tabs[0].source).toBe("participant A");
  });

  it("does not re-save an unchanged buffer", async () => {
    const repo = await seedRepo();
    const saveSpy = vi.spyOn(repo, "saveDiagramFile");
    const { result } = renderHook(() => useTabs(repo, doc1));

    // No edit: the initial save should not fire for the just-opened buffer.
    await act(async () => {});
    expect(saveSpy).not.toHaveBeenCalled();

    await act(async () => {
      result.current.updateActiveSource(diag1.source);
    });
    // Identical content is deduped, so still no save.
    await act(async () => {});
    expect(saveSpy).not.toHaveBeenCalled();

    await act(async () => {
      result.current.updateActiveSource("changed");
    });
    await act(async () => {});
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("saves under the file name when the title renames the diagram", async () => {
    const repo = await seedRepo();
    const saveSpy = vi.spyOn(repo, "saveDiagramFile");
    // The file is named `welcome.seq`; the source titles it `Welcome`.
    const named = tabDocumentOfDiagram({
      id: "diag-1",
      name: "welcome.seq",
      source: "title Welcome\nA -> B: hi",
      projectId: "proj-0",
    });
    const { result } = renderHook(() => useTabs(repo, named));

    await act(async () => {
      result.current.updateActiveSource("title Renamed\nA -> B: hi");
    });

    // The title is the display label; the file name is what gets persisted.
    expect(result.current.tabs[0].title).toBe("Renamed");
    expect(saveSpy).toHaveBeenCalledWith("proj-0", {
      id: "diag-1",
      name: "welcome.seq",
      source: "title Renamed\nA -> B: hi",
      projectId: "proj-0",
    });
  });

  it("reports each edit so the workspace can relabel the diagram", async () => {
    const repo = await seedRepo();
    const onDocumentEdit = vi.fn();
    const { result } = renderHook(() => useTabs(repo, doc1, onDocumentEdit));

    await act(async () => {
      result.current.updateActiveSource("title Changed");
    });
    await act(async () => {});

    expect(onDocumentEdit).toHaveBeenCalledWith({
      kind: "diagram",
      id: "diag-1",
      name: "Welcome",
      source: "title Changed",
      projectId: "proj-0",
    });
  });

  it("opens a markdown note into a tab and auto-saves its markdown", async () => {
    const repo = await seedRepo();
    const saveNoteSpy = vi.spyOn(repo, "saveNoteFile");
    const { result } = renderHook(() => useTabs(repo, noteDoc));

    expect(result.current.activeTab?.kind).toBe("note");
    expect(result.current.source).toBe(note1.markdown);

    await act(async () => {
      result.current.updateActiveSource("# Overview\n\nRewritten.");
    });

    // A note's buffer travels in `markdown`, not `source`.
    expect(saveNoteSpy).toHaveBeenCalledWith("proj-0", {
      id: "note-1",
      name: "Overview.md",
      markdown: "# Overview\n\nRewritten.",
      projectId: "proj-0",
    });
    expect(result.current.tabs[0].title).toBe("Overview");
  });

  it("keeps a diagram and a note open at once and switches buffers", async () => {
    const repo = await seedRepo();
    const { result, rerender } = renderHook(
      ({ selectedDocument }) => useTabs(repo, selectedDocument),
      { initialProps: { selectedDocument: doc1 as TabDocument | null } },
    );

    await act(async () => {
      rerender({ selectedDocument: noteDoc });
    });
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeTabId).toBe("note-1");
    expect(result.current.source).toBe(note1.markdown);

    // Switching back restores the diagram's own buffer.
    await act(async () => {
      result.current.activateTab("diag-1");
    });
    expect(result.current.source).toBe(diag1.source);
    expect(result.current.activeTab?.kind).toBe("diagram");
  });

  it("preserves an unsaved note buffer when switching away and back", async () => {
    const repo = await seedRepo();
    const { result } = renderHook(() => useTabs(repo, noteDoc));

    await act(async () => {
      result.current.updateActiveSource("# Overview\n\nDraft.");
    });
    await act(async () => {
      result.current.activateTab("diag-1");
    });
    await act(async () => {
      result.current.activateTab("note-1");
    });
    expect(result.current.source).toBe("# Overview\n\nDraft.");
  });

  it("activates and closes tabs", async () => {
    const repo = await seedRepo();
    const { result, rerender } = renderHook(
      ({ selectedDocument }) => useTabs(repo, selectedDocument),
      { initialProps: { selectedDocument: doc1 as TabDocument | null } },
    );

    // Opening the second diagram activates it.
    await act(async () => {
      rerender({ selectedDocument: doc2 });
    });
    expect(result.current.activeTabId).toBe("diag-2");

    // Switching back to the first (already-open) tab activates it.
    await act(async () => {
      result.current.activateTab("diag-1");
    });
    expect(result.current.activeTabId).toBe("diag-1");

    // Closing it falls back to the remaining tab and follows its buffer.
    await act(async () => {
      result.current.closeTab("diag-1");
    });
    expect(result.current.activeTabId).toBe("diag-2");
    expect(result.current.source).toBe(diag2.source);
  });

  it("folds an externally changed note into its open tab", async () => {
    const repo = await seedRepo();
    const { result } = renderHook(() => useTabs(repo, noteDoc));

    await act(async () => {
      result.current.applyExternalNote({
        ...note1,
        markdown: "# Retitled\n\nProse.",
      });
    });

    expect(result.current.source).toBe("# Retitled\n\nProse.");
    expect(result.current.tabs[0].title).toBe("Retitled");
    // The externally supplied content is already stored, so it is not dirty.
    expect(result.current.tabs[0].savedSource).toBe("# Retitled\n\nProse.");
  });
});
