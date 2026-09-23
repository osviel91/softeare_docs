import { describe, expect, it } from "vitest";
import type {
  DiagramFile,
  NoteFile,
  Project,
  WorkspaceSnapshot,
} from "../../src/domain/workspace/types";
import {
  exportWorkspaceToJSON,
  importWorkspaceFromJSON,
} from "../../src/workspace/serialize";

const project: Project = {
  id: "proj-1",
  name: "Onboarding",
  datasetIds: ["diag-1", "diag-2"],
  noteIds: ["note-1"],
};
const diagramA: DiagramFile = {
  id: "diag-1",
  name: "Welcome",
  source: "title Welcome\nA -> B: hi",
  projectId: "proj-1",
};
const diagramB: DiagramFile = {
  id: "diag-2",
  name: "Signup",
  source: "title Signup\nA -> B: join",
  projectId: "proj-1",
};
const note: NoteFile = {
  id: "note-1",
  name: "readme.md",
  markdown: "# Onboarding\n\nStart with [[Welcome]].",
  projectId: "proj-1",
};
const snapshot: WorkspaceSnapshot = {
  projects: [project],
  diagrams: [diagramA, diagramB],
  notes: [note],
};

describe("serialize", () => {
  it("exports a stable, readable JSON document", () => {
    const json = exportWorkspaceToJSON(snapshot);
    expect(json).toContain('"projects"');
    expect(json).toContain('"diagrams"');
    expect(json).toContain('"notes"');
    // Two-space indentation is part of the human-readable contract.
    expect(json).toContain('\n  "projects"');
    const parsed = JSON.parse(json);
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.diagrams).toHaveLength(2);
    expect(parsed.notes).toHaveLength(1);
  });

  it("round-trips a well-formed snapshot through export then import", () => {
    const parsed = importWorkspaceFromJSON(exportWorkspaceToJSON(snapshot));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(snapshot);
  });

  it("normalizes optional resource metadata while preserving legacy records", () => {
    const parsed = importWorkspaceFromJSON(
      JSON.stringify({
        projects: [{ id: "p", name: "Old", datasetIds: ["d"] }],
        diagrams: [
          {
            id: "d",
            name: "old.seq",
            source: "title Old",
            projectId: "p",
            metadata: { description: "  docs ", tags: ["A", " a "] },
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.diagrams[0].metadata).toEqual({
      description: "docs",
      tags: ["A"],
    });
  });

  it("accepts a document written before notes existed", () => {
    // No `notes` key and no `noteIds`: it still imports, with empty lists.
    const legacy = JSON.stringify({
      projects: [{ id: "p", name: "Old", datasetIds: [] }],
      diagrams: [],
    });
    const parsed = importWorkspaceFromJSON(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.notes).toEqual([]);
    expect(parsed.value.projects[0].noteIds).toEqual([]);
  });

  it("rejects a malformed note with its index", () => {
    const json = JSON.stringify({
      projects: [],
      diagrams: [],
      notes: [{ id: "n", name: "x.md" }],
    });
    const result = importWorkspaceFromJSON(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("notes[0]");
    }
  });

  it("returns copies so mutating the snapshot does not mutate the import", () => {
    const parsed = importWorkspaceFromJSON(exportWorkspaceToJSON(snapshot));
    if (!parsed.ok) return;
    parsed.value.projects[0].datasetIds.push("diag-999");
    expect(snapshot.projects[0].datasetIds).not.toContain("diag-999");
  });

  it("rejects invalid JSON", () => {
    const result = importWorkspaceFromJSON("{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid JSON");
    }
  });

  it("rejects a non-object document", () => {
    expect(importWorkspaceFromJSON("42").ok).toBe(false);
    expect(importWorkspaceFromJSON("null").ok).toBe(false);
    expect(importWorkspaceFromJSON('"string"').ok).toBe(false);
  });

  it("rejects when projects or diagrams is missing", () => {
    expect(importWorkspaceFromJSON(JSON.stringify({ diagrams: [] })).ok).toBe(
      false,
    );
    expect(importWorkspaceFromJSON(JSON.stringify({ projects: [] })).ok).toBe(
      false,
    );
  });

  it("rejects a malformed project with its index", () => {
    const json = JSON.stringify({ projects: [{ name: "ok" }], diagrams: [] });
    const result = importWorkspaceFromJSON(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("projects[0]");
    }
  });

  it("rejects a malformed diagram with its index", () => {
    const json = JSON.stringify({
      projects: [],
      diagrams: [{ id: "d", name: "x" }],
    });
    const result = importWorkspaceFromJSON(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("diagrams[0]");
    }
  });
});
