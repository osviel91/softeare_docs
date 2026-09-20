import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DiagramFile } from "../../../src/domain/workspace/types";
import { useCommands } from "../../../src/features/commands/use-commands";

/** A minimal, fully-mocked command context so the registry logic is tested in isolation. */
function mockContext(
  overrides: Partial<Parameters<typeof useCommands>[0]> = {},
) {
  const createEmptyDiagram =
    overrides.createEmptyDiagram ?? vi.fn(async () => null);
  const createEmptyNote = overrides.createEmptyNote ?? vi.fn(async () => null);
  const openDiagram = overrides.openDiagram ?? vi.fn();
  const createEventFlow = overrides.createEventFlow ?? vi.fn(async () => null);
  const closeActiveTab = overrides.closeActiveTab ?? vi.fn();
  const openSearch = overrides.openSearch ?? vi.fn();
  const openQuickOpen = overrides.openQuickOpen ?? vi.fn();
  const showView = overrides.showView ?? vi.fn();
  const findReferences = overrides.findReferences ?? vi.fn();
  const renameSymbol = overrides.renameSymbol ?? vi.fn();
  const exportDiagram = overrides.exportDiagram ?? vi.fn();
  const exportSite = overrides.exportSite ?? vi.fn();
  const exportProject = overrides.exportProject ?? vi.fn();
  const importProject = overrides.importProject ?? vi.fn();
  const openFolder = overrides.openFolder ?? vi.fn();

  const context = {
    createEmptyDiagram,
    createEmptyNote,
    selectedProjectId: null,
    openDiagram,
    createEventFlow,
    closeActiveTab,
    openSearch,
    openQuickOpen,
    showView,
    findReferences,
    renameSymbol,
    exportDiagram,
    exportSite,
    exportProject,
    importProject,
    openFolder,
    folderOpen: false,
    folderSupported: true,
    ...overrides,
  };

  return {
    context,
    createEmptyDiagram,
    createEmptyNote,
    openDiagram,
    createEventFlow,
    closeActiveTab,
    openSearch,
    openQuickOpen,
    showView,
    findReferences,
    renameSymbol,
    exportProject,
    importProject,
    openFolder,
  };
}

describe("useCommands", () => {
  it("always registers New Diagram and Close Tab", () => {
    const { context } = mockContext();
    const { result } = renderHook(() => useCommands(context));

    const ids = result.current.commands.map((c) => c.id);
    expect(ids).toContain("new-diagram");
    expect(ids).toContain("close-tab");
  });

  it("opens a tab after creating an empty diagram", async () => {
    const diagram: DiagramFile = {
      id: "diag-1",
      name: "Untitled",
      source: "",
      projectId: "proj-0",
    };
    const createEmptyDiagram = vi.fn(async () => diagram);
    const openDiagram = vi.fn();
    const { context } = mockContext({
      selectedProjectId: "proj-0",
      createEmptyDiagram,
      openDiagram,
    });

    const { result } = renderHook(() => useCommands(context));
    await result.current.run("new-diagram");

    expect(createEmptyDiagram).toHaveBeenCalledWith("proj-0");
    expect(openDiagram).toHaveBeenCalledWith(diagram);
  });

  it("does not create a diagram when no project is selected", async () => {
    const createEmptyDiagram = vi.fn(async () => null);
    const openDiagram = vi.fn();
    const { context } = mockContext({
      selectedProjectId: null,
      createEmptyDiagram,
      openDiagram,
    });

    const { result } = renderHook(() => useCommands(context));
    await result.current.run("new-diagram");

    expect(createEmptyDiagram).not.toHaveBeenCalled();
    expect(openDiagram).not.toHaveBeenCalled();
  });

  it("offers Open Folder when supported and closed, Close Folder when open", async () => {
    const closed = renderHook(() =>
      useCommands(
        mockContext({ folderSupported: true, folderOpen: false }).context,
      ),
    );
    const closedIds = closed.result.current.commands.map((c) => c.id);
    expect(closedIds).toContain("open-folder");
    expect(closedIds).not.toContain("close-folder");

    const opened = renderHook(() =>
      useCommands(
        mockContext({ folderSupported: true, folderOpen: true }).context,
      ),
    );
    const openedIds = opened.result.current.commands.map((c) => c.id);
    expect(openedIds).toContain("close-folder");
    expect(openedIds).not.toContain("open-folder");
  });

  it("hides folder commands when the File System Access API is unsupported", async () => {
    const { context } = mockContext({
      folderSupported: false,
      folderOpen: true,
    });
    const { result } = renderHook(() => useCommands(context));
    const ids = result.current.commands.map((c) => c.id);
    expect(ids).not.toContain("open-folder");
    expect(ids).not.toContain("close-folder");
  });

  it("runs Close Tab through the provided callback", async () => {
    const closeActiveTab = vi.fn();
    const { context } = mockContext({ closeActiveTab });
    const { result } = renderHook(() => useCommands(context));
    await result.current.run("close-tab");
    expect(closeActiveTab).toHaveBeenCalledTimes(1);
  });

  it("offers Search Project and runs it through the provided callback", async () => {
    const openSearch = vi.fn();
    const { context } = mockContext({ openSearch });
    const { result } = renderHook(() => useCommands(context));

    expect(result.current.commands.map((c) => c.id)).toContain(
      "search-project",
    );
    await result.current.run("search-project");
    expect(openSearch).toHaveBeenCalledTimes(1);
  });
});
