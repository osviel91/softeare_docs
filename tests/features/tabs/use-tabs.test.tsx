import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createInMemoryWorkspaceRepository } from "../../../src/workspace/in-memory";
import { useTabs } from "../../../src/features/tabs/use-tabs";

/** Seed a project with two diagrams so the hook has real files to wrap. */
async function seedRepo() {
  const repo = createInMemoryWorkspaceRepository();
  await repo.createProject("Alpha");
  await repo.saveDiagramFile("proj-0", {
    id: "diag-1",
    name: "Welcome",
    source: "title Welcome\nA -> B: hi",
    projectId: "proj-0",
  });
  await repo.saveDiagramFile("proj-0", {
    id: "diag-2",
    name: "Flow",
    source: "title Flow\nX -> Y: bye",
    projectId: "proj-0",
  });
  return repo;
}

const diag1 = {
  id: "diag-1",
  name: "Welcome",
  source: "title Welcome\nA -> B: hi",
  projectId: "proj-0",
};

const diag2 = {
  id: "diag-2",
  name: "Flow",
  source: "title Flow\nX -> Y: bye",
  projectId: "proj-0",
};

describe("useTabs", () => {
  it("opens the selected diagram into a tab with its source", async () => {
    const repo = await seedRepo();
    const { result, rerender } = renderHook(
      ({ selectedDiagram }) => useTabs(repo, selectedDiagram),
      {
        initialProps: { selectedDiagram: null } as {
          selectedDiagram: null | typeof diag1;
        },
      },
    );

    // No diagram selected yet: no tab, editor falls back to the seeded sample.
    expect(result.current.tabs).toHaveLength(0);

    await act(async () => {
      rerender({ selectedDiagram: diag1 });
    });
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTabId).toBe("diag-1");
    expect(result.current.source).toBe(diag1.source);
  });

  it("updates the editor source when editing with no tab open", async () => {
    const repo = await seedRepo();
    const saveSpy = vi.spyOn(repo, "saveDiagramFile");
    const { result } = renderHook(() => useTabs(repo, null));

    // No diagram loaded: editing still drives the editor source (and preview).
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
    const { result } = renderHook(() => useTabs(repo, diag1));

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

  it("does not re-save an unchanged buffer", async () => {
    const repo = await seedRepo();
    const saveSpy = vi.spyOn(repo, "saveDiagramFile");
    const { result } = renderHook(() => useTabs(repo, diag1));

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

  it("activates and closes tabs", async () => {
    const repo = await seedRepo();
    const { result, rerender } = renderHook(
      ({ selectedDiagram }) => useTabs(repo, selectedDiagram),
      { initialProps: { selectedDiagram: diag1 } },
    );

    // Opening the second diagram activates it.
    await act(async () => {
      rerender({ selectedDiagram: diag2 });
    });
    expect(result.current.activeTabId).toBe("diag-2");

    // Switching back to the first (already-open) tab activates it.
    await act(async () => {
      result.current.activateTab("diag-1");
    });
    expect(result.current.activeTabId).toBe("diag-1");

    // Closing it falls back to the remaining tab.
    await act(async () => {
      result.current.closeTab("diag-1");
    });
    expect(result.current.activeTabId).toBe("diag-2");
  });
});
