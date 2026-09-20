import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { DiagramFile, Project } from "../../../src/domain/workspace/types";
import Explorer from "../../../src/features/explorer/Explorer";

const project: Project = {
  id: "proj-1",
  name: "Onboarding",
  datasetIds: ["diag-1"],
};
const diagram: DiagramFile = {
  id: "diag-1",
  name: "Welcome",
  source: "title Welcome\nA -> B: hi",
  projectId: "proj-1",
};

describe("Explorer", () => {
  it("shows an empty hint when there are no projects", () => {
    render(
      <Explorer
        projects={[]}
        diagrams={[]}
        selectedProjectId={null}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.getByTestId("explorer-empty")).toBeInTheDocument();
  });

  it("shows a loading state while data is fetching", () => {
    render(
      <Explorer
        projects={[]}
        diagrams={[]}
        selectedProjectId={null}
        selectedDiagramId={null}
        isLoading={true}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.getByTestId("explorer-loading")).toBeInTheDocument();
  });

  it("lists projects and their diagrams", () => {
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.getByTestId("project-name")).toHaveTextContent("Onboarding");
    const buttons = screen.getAllByTestId("explorer-diagram");
    expect(buttons).toHaveLength(1);
    expect(screen.getByLabelText("Load diagram Welcome")).toBeInTheDocument();
  });

  it("shows a diagram by the title in its source, not its file name", () => {
    const named: DiagramFile = {
      id: "diag-9",
      name: "report.seq",
      source: "title Quarterly Report",
      projectId: "proj-1",
    };
    render(
      <Explorer
        projects={[project]}
        diagrams={[named]}
        selectedProjectId={project.id}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(
      screen.getByLabelText("Load diagram Quarterly Report"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Load diagram report.seq")).toBeNull();
  });

  it("finds a diagram by its title or by its file name", () => {
    const named: DiagramFile = {
      id: "diag-9",
      name: "report.seq",
      source: "title Quarterly Report",
      projectId: "proj-1",
    };
    render(
      <Explorer
        projects={[project]}
        diagrams={[named]}
        allDiagrams={[named]}
        selectedProjectId={project.id}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );

    const search = screen.getByTestId("diagram-search-input");
    fireEvent.change(search, { target: { value: "quarterly" } });
    expect(
      screen.getByLabelText("Load diagram Quarterly Report"),
    ).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "report.seq" } });
    expect(
      screen.getByLabelText("Load diagram Quarterly Report"),
    ).toBeInTheDocument();
  });

  it("shows a hint for a selected project with no diagrams", () => {
    render(
      <Explorer
        projects={[project]}
        diagrams={[]}
        selectedProjectId={project.id}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.getByTestId("explorer-diagram-empty")).toHaveTextContent(
      "No diagrams.",
    );
  });

  it("calls onLoadDiagram when a diagram is selected", () => {
    const onLoadDiagram = vi.fn();
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={onLoadDiagram}
      />,
    );
    fireEvent.click(screen.getByLabelText("Load diagram Welcome"));
    expect(onLoadDiagram).toHaveBeenCalledWith(diagram);
  });

  it("deletes a project through the delete button", () => {
    const onDeleteProject = vi.fn();
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={onDeleteProject}
        onLoadDiagram={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Delete project Onboarding"));
    expect(onDeleteProject).toHaveBeenCalledWith(project.id);
  });

  it("opens the add menu for a project instead of creating straight away", () => {
    const onAddMenu = vi.fn();
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onAddMenu={onAddMenu}
        onLoadDiagram={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("project-add-button"));
    expect(onAddMenu).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
  });

  it("omits the add button when no add handler is provided", () => {
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("project-add-button")).toBeNull();
  });

  it("enables the create button only after typing a name", () => {
    const onCreateProject = vi.fn();
    render(
      <Explorer
        projects={[]}
        diagrams={[]}
        selectedProjectId={null}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={onCreateProject}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    const input = screen.getByTestId("project-name-input") as HTMLInputElement;
    const button = screen.getByTestId(
      "create-project-button",
    ) as HTMLButtonElement;
    expect(button).toBeDisabled();

    fireEvent.change(input, { target: { value: "  New project  " } });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(onCreateProject).toHaveBeenCalledWith("New project");
  });

  it("shows the folder picker when onOpenFolder is provided", () => {
    render(
      <Explorer
        projects={[]}
        diagrams={[]}
        selectedProjectId={null}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
        onOpenFolder={vi.fn()}
        folderSupported={true}
      />,
    );
    expect(screen.getByTestId("open-folder-button")).toHaveTextContent(
      "Open folder…",
    );
  });

  it("calls onOpenFolder when the folder button is clicked", () => {
    const onOpenFolder = vi.fn();
    render(
      <Explorer
        projects={[]}
        diagrams={[]}
        selectedProjectId={null}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
        onOpenFolder={onOpenFolder}
        folderSupported={true}
      />,
    );
    fireEvent.click(screen.getByTestId("open-folder-button"));
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it("switches to Close folder and shows the folder name when one is open", () => {
    render(
      <Explorer
        projects={[]}
        diagrams={[]}
        selectedProjectId={null}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
        onOpenFolder={vi.fn()}
        folderName="My Diagrams"
        folderSupported={true}
      />,
    );
    expect(screen.getByTestId("explorer-mode")).toHaveTextContent(
      "My Diagrams",
    );
    expect(screen.getByTestId("open-folder-button")).toHaveTextContent(
      "Close folder",
    );
  });

  it("disables the folder button when the API is unsupported", () => {
    render(
      <Explorer
        projects={[]}
        diagrams={[]}
        selectedProjectId={null}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
        onOpenFolder={vi.fn()}
        folderSupported={false}
      />,
    );
    expect(screen.getByTestId("open-folder-button")).toBeDisabled();
  });

  it("renders a diagram search box", () => {
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.getByTestId("diagram-search-input")).toBeInTheDocument();
  });

  it("filters the selected project's diagrams by name while searching", () => {
    const other: DiagramFile = {
      id: "diag-2",
      name: "Login",
      source: "title Login",
      projectId: "proj-1",
    };
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram, other]}
        allDiagrams={[diagram, other]}
        selectedProjectId={project.id}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId("diagram-search-input"), {
      target: { value: "welcome" },
    });
    expect(screen.getAllByTestId("explorer-diagram")).toHaveLength(1);
    expect(screen.getByLabelText("Load diagram Welcome")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("diagram-search-input"), {
      target: { value: "login" },
    });
    expect(screen.getByLabelText("Load diagram Login")).toBeInTheDocument();
  });

  it("searches across all projects when a query is present", () => {
    const otherProject: Project = {
      id: "proj-2",
      name: "Work",
      datasetIds: ["diag-3"],
    };
    const otherDiagram: DiagramFile = {
      id: "diag-3",
      name: "Report",
      source: "title Report",
      projectId: "proj-2",
    };
    const onLoadDiagram = vi.fn();
    render(
      <Explorer
        projects={[project, otherProject]}
        diagrams={[diagram]}
        allDiagrams={[diagram, otherDiagram]}
        selectedProjectId={project.id}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={onLoadDiagram}
      />,
    );

    // The Report diagram lives in a different project; it is not listed without
    // a search, but the search box surfaces it across projects.
    expect(screen.queryByLabelText("Load diagram Report")).toBeNull();

    fireEvent.change(screen.getByTestId("diagram-search-input"), {
      target: { value: "report" },
    });
    expect(screen.getByLabelText("Load diagram Report")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Load diagram Report"));
    expect(onLoadDiagram).toHaveBeenCalledWith(otherDiagram);
  });

  it("shows a no-match hint when nothing matches the query", () => {
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        allDiagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("diagram-search-input"), {
      target: { value: "does-not-exist" },
    });
    expect(screen.getByTestId("explorer-empty")).toHaveTextContent(
      "No diagrams or notes match",
    );
  });

  it("hides the folder button when onOpenFolder is not provided", () => {
    render(
      <Explorer
        projects={[]}
        diagrams={[]}
        selectedProjectId={null}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("open-folder-button")).toBeNull();
  });
});

describe("Explorer — deleting diagrams", () => {
  it("offers a delete button per diagram when a handler is provided", () => {
    const onDeleteDiagram = vi.fn();
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onDeleteDiagram={onDeleteDiagram}
        onLoadDiagram={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("delete-diagram-button"));
    expect(onDeleteDiagram).toHaveBeenCalledWith(diagram);
  });

  it("omits the delete button when no handler is provided", () => {
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("delete-diagram-button")).toBeNull();
  });

  it("does not load the diagram when its delete button is clicked", () => {
    const onDeleteDiagram = vi.fn();
    const onLoadDiagram = vi.fn();
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onDeleteDiagram={onDeleteDiagram}
        onLoadDiagram={onLoadDiagram}
      />,
    );
    fireEvent.click(screen.getByTestId("delete-diagram-button"));
    expect(onLoadDiagram).not.toHaveBeenCalled();
  });
});

describe("Explorer — paths removed from the app", () => {
  it("shows a restore control when paths are hidden", () => {
    const onUnhideAll = vi.fn();
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
        hiddenCount={2}
        onUnhideAll={onUnhideAll}
      />,
    );
    expect(screen.getByTestId("explorer-hidden")).toHaveTextContent(
      "2 removed from app",
    );
    fireEvent.click(screen.getByTestId("unhide-all-button"));
    expect(onUnhideAll).toHaveBeenCalledTimes(1);
  });

  it("hides the restore control when nothing is hidden", () => {
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("explorer-hidden")).toBeNull();
  });
});
