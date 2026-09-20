import { describe, expect, it } from "vitest";
import type {
  DiagramFile,
  NoteFile,
  Project,
} from "../../../src/domain/workspace/types";
import { buildSearchDocuments } from "../../../src/features/search/search-documents";

const projects: Project[] = [
  { id: "docs", name: "Docs", datasetIds: ["diag-1"], noteIds: ["note-1"] },
];

const diagram: DiagramFile = {
  id: "diag-1",
  name: "checkout.seq",
  projectId: "docs",
  source: [
    "title Checkout Flow",
    'participant api as "Payments API"',
    "participant DB",
    "api ->> DB: Save",
  ].join("\n"),
};

const note: NoteFile = {
  id: "note-1",
  name: "architecture.md",
  projectId: "docs",
  markdown: "# Architecture\n\nThe API is documented here.",
};

describe("buildSearchDocuments", () => {
  it("carries each file's content and display title", () => {
    const [first, second] = buildSearchDocuments(projects, [diagram], [note]);
    expect(first).toMatchObject({
      kind: "diagram",
      id: "diag-1",
      projectName: "Docs",
      title: "Checkout Flow",
      content: diagram.source,
    });
    expect(second).toMatchObject({
      kind: "note",
      id: "note-1",
      projectName: "Docs",
      title: "Architecture",
      content: note.markdown,
    });
  });

  it("derives a diagram's participants from its AST", () => {
    const [document] = buildSearchDocuments(projects, [diagram], []);
    // Both the id and the readable label are searchable.
    expect(document.facets?.participants).toContain("api");
    expect(document.facets?.participants).toContain("Payments API");
    expect(document.facets?.participants).toContain("DB");
  });

  it("contributes no participants for a diagram that does not parse", () => {
    const broken: DiagramFile = { ...diagram, source: "participant" };
    const [document] = buildSearchDocuments(projects, [broken], []);
    expect(document.facets?.participants).toEqual([]);
  });

  it("falls back to the project id when the project is unknown", () => {
    const orphan: NoteFile = { ...note, projectId: "gone" };
    const [document] = buildSearchDocuments(projects, [], [orphan]);
    expect(document.projectName).toBe("gone");
  });
});
