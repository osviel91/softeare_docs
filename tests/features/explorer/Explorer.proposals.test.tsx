import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Explorer from "../../../src/features/explorer/Explorer";

const props = {
  projects: [{ id: "project-1", name: "Project", datasetIds: ["one", "two"] }],
  diagrams: [
    { id: "one", name: "one.seq", source: "title One", projectId: "project-1" },
    { id: "two", name: "two.seq", source: "title Two", projectId: "project-1" },
  ],
  selectedProjectId: "project-1",
  selectedDiagramId: null,
  isLoading: false,
  onCreateProject: vi.fn(),
  onLoadDiagram: vi.fn(),
};

describe("Explorer proposal indicators", () => {
  it("marks resources with open proposals and includes counts", () => {
    render(<Explorer {...props} openProposalCounts={{ one: 1, two: 2 }} />);
    expect(screen.getByTitle("1 open change")).toBeInTheDocument();
    expect(screen.getByTitle("2 open changes")).toBeInTheDocument();
  });

  it("does not render a marker for resources without open proposals", () => {
    render(<Explorer {...props} />);
    expect(screen.queryByText("◆")).toBeNull();
  });
});
