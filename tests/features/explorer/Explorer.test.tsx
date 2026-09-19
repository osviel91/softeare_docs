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
});
