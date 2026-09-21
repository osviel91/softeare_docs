import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type {
  DiagramFile,
  NoteFile,
  Project,
} from "../../../src/domain/workspace/types";
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
const note: NoteFile = {
  id: "note-1",
  name: "Intro.md",
  markdown: "# Intro",
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
        onLoadDiagram={onLoadDiagram}
      />,
    );
    fireEvent.click(screen.getByLabelText("Load diagram Welcome"));
    expect(onLoadDiagram).toHaveBeenCalledWith(diagram);
  });

  it("opens the project actions menu from the ⋯ button", () => {
    const onProjectMenu = vi.fn();
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onProjectMenu={onProjectMenu}
        onLoadDiagram={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("project-menu-button"));
    expect(onProjectMenu).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
  });

  it("offers no bare delete button on a project header", () => {
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onProjectMenu={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    // Delete lives in the ⋯ menu, which the shell builds, not on the header.
    expect(screen.queryByTestId("delete-project-button")).toBeNull();
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
        onLoadDiagram={onLoadDiagram}
      />,
    );

    // Every expanded project lists its own files, so Work's Report is visible
    // without a search; the search box then narrows the list across projects.
    expect(screen.getByLabelText("Load diagram Report")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("diagram-search-input"), {
      target: { value: "report" },
    });
    expect(screen.getByLabelText("Load diagram Report")).toBeInTheDocument();
    expect(screen.queryByLabelText("Load diagram Welcome")).toBeNull();

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
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("open-folder-button")).toBeNull();
  });
});

describe("Explorer — file actions menu", () => {
  it("opens a diagram's actions menu from its ⋯ button", () => {
    const onDiagramMenu = vi.fn();
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDiagramMenu={onDiagramMenu}
        onLoadDiagram={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("diagram-menu-button"));
    expect(onDiagramMenu).toHaveBeenCalledWith(
      diagram,
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
  });

  it("never renders a bare delete button on a diagram or note row", () => {
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        notes={[note]}
        allNotes={[note]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDiagramMenu={vi.fn()}
        onNoteMenu={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    // Delete is a menu item, so the row itself carries no destructive affordance.
    expect(screen.queryByTestId("delete-diagram-button")).toBeNull();
    expect(screen.queryByTestId("delete-note-button")).toBeNull();
  });

  it("does not load the diagram when its actions menu button is clicked", () => {
    const onDiagramMenu = vi.fn();
    const onLoadDiagram = vi.fn();
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onDiagramMenu={onDiagramMenu}
        onLoadDiagram={onLoadDiagram}
      />,
    );
    fireEvent.click(screen.getByTestId("diagram-menu-button"));
    expect(onLoadDiagram).not.toHaveBeenCalled();
  });
});

describe("Explorer — collapsing projects", () => {
  it("shows an expanded project's files while another project is selected", () => {
    const other: Project = { id: "proj-2", name: "Other", datasetIds: [] };
    render(
      <Explorer
        projects={[project, other]}
        // The selected project's own lists are empty; the workspace-wide list
        // still carries `Onboarding`'s file, which is what an expanded row shows.
        diagrams={[]}
        notes={[]}
        allDiagrams={[diagram]}
        allNotes={[]}
        selectedProjectId={other.id}
        selectedDiagramId={null}
        isLoading={false}
        onCreateProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Load diagram Welcome")).toBeInTheDocument();
  });

  it("hides a collapsed project's files behind its header", () => {
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        collapsedProjectIds={[project.id]}
        onToggleProjectCollapse={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    // The header stays; the file lists are gone.
    expect(screen.getByTestId("project-name")).toHaveTextContent("Onboarding");
    expect(screen.queryByTestId("explorer-diagrams")).toBeNull();
    expect(screen.queryByTestId("select-diagram-button")).toBeNull();
  });

  it("reports a collapse toggle with the project id", () => {
    const onToggleProjectCollapse = vi.fn();
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        collapsedProjectIds={[]}
        onToggleProjectCollapse={onToggleProjectCollapse}
        onLoadDiagram={vi.fn()}
      />,
    );
    const toggle = screen.getByTestId("project-collapse-button");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(onToggleProjectCollapse).toHaveBeenCalledWith(project.id);
  });

  it("reports a collapsed project as collapsed to assistive tech", () => {
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        collapsedProjectIds={[project.id]}
        onToggleProjectCollapse={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.getByTestId("project-collapse-button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("shows matching files even while a project is collapsed", () => {
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        allDiagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        collapsedProjectIds={[project.id]}
        onToggleProjectCollapse={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("diagram-search-input"), {
      target: { value: "welcome" },
    });
    // Searching is how a collapsed file is found, so the match must be visible.
    expect(screen.getByLabelText("Load diagram Welcome")).toBeInTheDocument();
  });

  it("omits the chevron when no toggle handler is provided", () => {
    render(
      <Explorer
        projects={[project]}
        diagrams={[diagram]}
        selectedProjectId={project.id}
        selectedDiagramId={diagram.id}
        isLoading={false}
        onCreateProject={vi.fn()}
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("project-collapse-button")).toBeNull();
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
        onLoadDiagram={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("explorer-hidden")).toBeNull();
  });
});
