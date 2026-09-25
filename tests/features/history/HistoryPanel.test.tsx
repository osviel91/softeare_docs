import { describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import HistoryPanel from "../../../src/features/history/HistoryPanel";
import type { DiagramVersion } from "../../../src/domain/workspace/version";

/** Build a version with deterministic content and time. */
function version(
  id: string,
  source: string,
  createdAt: number,
  label = "Auto checkpoint",
): DiagramVersion {
  return {
    id,
    diagramId: "diag-1",
    projectId: "proj-1",
    name: "diagram.seq",
    source,
    createdAt,
    label,
  };
}

const VERSIONS: DiagramVersion[] = [
  version("ver-2", "title Two\nA -> B: hi", 2_000, "Auto checkpoint"),
  version("ver-1", "title One\nA -> B: hi", 1_000, "Initial version"),
];

/** Render the panel with sensible defaults. */
function renderPanel(
  overrides: Partial<Parameters<typeof HistoryPanel>[0]> = {},
) {
  const props = {
    versions: VERSIONS,
    isLoading: false,
    hasDiagram: true,
    currentSource: "title Two\nA -> B: hi",
    onSaveVersion: vi.fn(),
    onRestore: vi.fn(),
    onDeleteVersion: vi.fn(),
    ...overrides,
  };
  render(<HistoryPanel {...props} />);
  return props;
}

describe("HistoryPanel", () => {
  it("lists versions newest first with their label and summary", () => {
    renderPanel();
    const rows = screen.getAllByTestId("history-version");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Auto checkpoint");
    expect(rows[0]).toHaveTextContent("title Two");
    expect(rows[1]).toHaveTextContent("Initial version");
    expect(rows[1]).toHaveTextContent("title One");
  });

  it("marks the version matching the editor buffer as current", () => {
    renderPanel();
    const rows = screen.getAllByTestId("history-version");
    expect(rows[0]).toHaveClass("history__version--current");
    expect(rows[1]).not.toHaveClass("history__version--current");
  });

  it("disables restore for the current version only", () => {
    renderPanel();
    const buttons = screen.getAllByTestId("restore-version-button");
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeEnabled();
  });

  it("reports the version count", () => {
    renderPanel();
    expect(screen.getByTestId("history-count")).toHaveTextContent("2 versions");
  });

  it("captures a checkpoint on demand", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByTestId("save-version-button"));
    expect(props.onSaveVersion).toHaveBeenCalledTimes(1);
  });

  it("restores an older version", () => {
    const props = renderPanel();
    fireEvent.click(screen.getAllByTestId("restore-version-button")[1]);
    expect(props.onRestore).toHaveBeenCalledWith(VERSIONS[1]);
  });

  it("forgets a version", () => {
    const props = renderPanel();
    fireEvent.click(screen.getAllByTestId("delete-version-button")[1]);
    expect(props.onDeleteVersion).toHaveBeenCalledWith("ver-1");
  });

  it("disables capture when no diagram is open", () => {
    renderPanel({ hasDiagram: false, versions: [] });
    expect(screen.getByTestId("save-version-button")).toBeDisabled();
    expect(screen.getByTestId("history-empty")).toHaveTextContent(
      "Open a diagram",
    );
  });

  it("shows a loading hint before the first timeline arrives", () => {
    renderPanel({ versions: [], isLoading: true });
    expect(screen.getByTestId("history-loading")).toBeInTheDocument();
  });

  it("invites an edit when the timeline is empty", () => {
    renderPanel({ versions: [], isLoading: false });
    expect(screen.getByTestId("history-empty")).toHaveTextContent(
      "No versions yet",
    );
  });

  it("uses the same scope navigation in both history views", () => {
    const showProject = vi.fn();
    const showResource = vi.fn();
    renderPanel({
      resourceScoped: true,
      onShowProjectHistory: showProject,
    });
    expect(screen.getByTestId("project-history-navigation")).toHaveTextContent(
      "Project history",
    );
    fireEvent.click(screen.getByTestId("project-history-navigation"));
    expect(showProject).toHaveBeenCalledTimes(1);

    cleanup();
    renderPanel({
      activeDiagramId: "diag-1",
      onShowResourceHistory: showResource,
    });
    expect(screen.getByTestId("resource-history-navigation")).toHaveTextContent(
      "Resource history",
    );
    fireEvent.click(screen.getByTestId("resource-history-navigation"));
    expect(showResource).toHaveBeenCalledTimes(1);
  });
});

describe("HistoryPanel — project tree", () => {
  /** Render the panel over a two-diagram project history. */
  function renderTree(
    overrides: Partial<Parameters<typeof HistoryPanel>[0]> = {},
  ) {
    const props = {
      versions: [
        { ...version("ver-2", "title Two", 2_000), diagramId: "diag-2" },
        { ...version("ver-1", "title One", 1_000), diagramId: "diag-1" },
      ],
      isLoading: false,
      hasDiagram: true,
      currentSource: "",
      activeDiagramId: "diag-2",
      labelForDiagram: (diagramId: string) =>
        diagramId === "diag-2" ? "Second" : "First",
      kindForDiagram: () => "sequence-diagram",
      projectName: "Docs",
      onSaveVersion: vi.fn(),
      onRestore: vi.fn(),
      onDeleteVersion: vi.fn(),
      ...overrides,
    };
    render(<HistoryPanel {...props} />);
    return props;
  }

  it("groups versions into one branch per diagram", () => {
    renderTree();

    const branches = screen.getAllByTestId("history-branch");
    expect(branches).toHaveLength(2);
    expect(branches[0]).toHaveTextContent("Second");
    expect(branches[1]).toHaveTextContent("First");

    // A version stays under the diagram it belongs to.
    const rows = within(branches[0]).getAllByTestId("history-version");
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute("data-diagram-id")).toBe("diag-2");

    // Only the open diagram's branch is marked.
    expect(
      within(branches[0]).getByTestId("history-branch-open"),
    ).toBeInTheDocument();
    expect(within(branches[1]).queryByTestId("history-branch-open")).toBeNull();

    // The header names the project.
    expect(screen.getByTestId("history-project")).toHaveTextContent("Docs");
  });

  it("marks Current only in the open diagram's branch", () => {
    const sameSource = "title Same\nA -> B: hi";
    renderTree({
      versions: [
        { ...version("ver-2", sameSource, 2_000), diagramId: "diag-2" },
        { ...version("ver-1", sameSource, 1_000), diagramId: "diag-1" },
      ],
      currentSource: sameSource,
    });

    // Identical content in two diagrams: only the open one is "Current".
    expect(screen.getAllByTestId("version-current")).toHaveLength(1);
    const branches = screen.getAllByTestId("history-branch");
    expect(
      within(branches[0]).getByTestId("version-current"),
    ).toBeInTheDocument();
  });
});
