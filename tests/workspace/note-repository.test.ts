import { describe, expect, it } from "vitest";
import type { NoteFile } from "../../src/domain/workspace/types";
import { isOk } from "../../src/shared/result/result";
import { createInMemoryWorkspaceRepository } from "../../src/workspace/in-memory";
import { createIndexedDbRepository } from "../../src/workspace/indexed-db";
import type { WorkspaceRepository } from "../../src/workspace/WorkspaceRepository";
import { FakeFactory } from "./fake-idb";

/**
 * The note and rename behaviors every repository must share. Running the same
 * suite over both durable-agnostic implementations is what keeps the in-memory
 * fallback honest: a test that passes only for IndexedDB would hide a divergence
 * the app would hit in jsdom or a storage-less browser.
 */
const backends: Array<[string, () => WorkspaceRepository]> = [
  ["in-memory", createInMemoryWorkspaceRepository],
  ["IndexedDB", () => createIndexedDbRepository(new FakeFactory())],
];

describe.each(backends)("notes — %s repository", (_name, makeRepo) => {
  /** A repository holding one project with one created note. */
  async function withNote(): Promise<{
    repo: WorkspaceRepository;
    projectId: string;
    note: NoteFile;
  }> {
    const repo = makeRepo();
    const project = await repo.createProject("Docs");
    if (!isOk(project)) throw project.error;
    const note = await repo.createEmptyNote(project.value.id);
    if (!isOk(note)) throw note.error;
    return { repo, projectId: project.value.id, note: note.value };
  }

  it("creates a note seeded with a heading", async () => {
    const { repo, projectId, note } = await withNote();
    expect(note.name).toBe("Untitled.md");
    expect(note.markdown).toBe("# Untitled\n");
    expect(note.projectId).toBe(projectId);

    const listed = await repo.listNoteFiles(projectId);
    if (!isOk(listed)) throw listed.error;
    expect(listed.value.map((entry) => entry.id)).toEqual([note.id]);
  });

  it("gives a second note a unique name", async () => {
    const { repo, projectId } = await withNote();
    const second = await repo.createEmptyNote(projectId);
    if (!isOk(second)) throw second.error;
    expect(second.value.name).toBe("Untitled 2.md");
  });

  it("saves a note's markdown and returns the stored copy", async () => {
    const { repo, projectId, note } = await withNote();
    const saved = await repo.saveNoteFile(projectId, {
      ...note,
      markdown: "# Guide\n\nSee [[Welcome]].",
    });
    if (!isOk(saved)) throw saved.error;
    expect(saved.value.markdown).toBe("# Guide\n\nSee [[Welcome]].");

    const read = await repo.getNoteFile(projectId, note.id);
    if (!isOk(read)) throw read.error;
    expect(read.value?.markdown).toContain("[[Welcome]]");
  });

  it("does not return a note from another project", async () => {
    const { repo, note } = await withNote();
    const other = await repo.createProject("Other");
    if (!isOk(other)) throw other.error;
    const read = await repo.getNoteFile(other.value.id, note.id);
    if (!isOk(read)) throw read.error;
    expect(read.value).toBeNull();
  });

  it("deletes one note without touching the others", async () => {
    const { repo, projectId, note } = await withNote();
    const second = await repo.createEmptyNote(projectId);
    if (!isOk(second)) throw second.error;

    const deleted = await repo.deleteNoteFile(projectId, note.id);
    expect(isOk(deleted)).toBe(true);

    const listed = await repo.listNoteFiles(projectId);
    if (!isOk(listed)) throw listed.error;
    expect(listed.value.map((entry) => entry.id)).toEqual([second.value.id]);
  });

  it("removes a project's notes with the project", async () => {
    const { repo, projectId, note } = await withNote();
    await repo.deleteProject(projectId);
    const read = await repo.getNoteFile(projectId, note.id);
    if (!isOk(read)) throw read.error;
    expect(read.value).toBeNull();
    const listed = await repo.listNoteFiles(projectId);
    if (!isOk(listed)) throw listed.error;
    expect(listed.value).toEqual([]);
  });

  it("renames a note's file without changing its id", async () => {
    const { repo, projectId, note } = await withNote();
    const renamed = await repo.renameNoteFile(
      projectId,
      note.id,
      "architecture.md",
    );
    if (!isOk(renamed)) throw renamed.error;
    expect(renamed.value.id).toBe(note.id);
    expect(renamed.value.name).toBe("architecture.md");
    // The content is untouched by a rename.
    expect(renamed.value.markdown).toBe(note.markdown);
  });

  it("refuses a rename onto an existing note name", async () => {
    const { repo, projectId, note } = await withNote();
    const second = await repo.createEmptyNote(projectId);
    if (!isOk(second)) throw second.error;

    const renamed = await repo.renameNoteFile(
      projectId,
      note.id,
      second.value.name,
    );
    expect(isOk(renamed)).toBe(false);
  });

  it("rejects an empty note name", async () => {
    const { repo, projectId, note } = await withNote();
    const renamed = await repo.renameNoteFile(projectId, note.id, "   ");
    expect(isOk(renamed)).toBe(false);
  });

  it("renames a diagram's file without changing its id", async () => {
    const repo = makeRepo();
    const project = await repo.createProject("Docs");
    if (!isOk(project)) throw project.error;
    const diagram = await repo.createEmptyDiagram(project.value.id);
    if (!isOk(diagram)) throw diagram.error;

    const renamed = await repo.renameDiagramFile(
      project.value.id,
      diagram.value.id,
      "flow.seq",
    );
    if (!isOk(renamed)) throw renamed.error;
    expect(renamed.value.id).toBe(diagram.value.id);
    expect(renamed.value.name).toBe("flow.seq");
  });

  it("refuses to rename a diagram onto an existing name", async () => {
    const repo = makeRepo();
    const project = await repo.createProject("Docs");
    if (!isOk(project)) throw project.error;
    const first = await repo.createEmptyDiagram(project.value.id);
    const second = await repo.createEmptyDiagram(project.value.id);
    if (!isOk(first) || !isOk(second)) throw new Error("create failed");

    const renamed = await repo.renameDiagramFile(
      project.value.id,
      first.value.id,
      second.value.name,
    );
    expect(isOk(renamed)).toBe(false);
  });

  it("duplicates a note under a free copy name", async () => {
    const { repo, projectId, note } = await withNote();
    const copy = await repo.duplicateNoteFile(projectId, note.id);
    if (!isOk(copy)) throw copy.error;
    expect(copy.value.id).not.toBe(note.id);
    expect(copy.value.name).toBe("Untitled copy.md");
    expect(copy.value.markdown).toBe(note.markdown);
    expect(copy.value.projectId).toBe(projectId);

    // A second duplicate must not overwrite the first.
    const second = await repo.duplicateNoteFile(projectId, note.id);
    if (!isOk(second)) throw second.error;
    expect(second.value.name).toBe("Untitled copy 2.md");

    const listed = await repo.listNoteFiles(projectId);
    if (!isOk(listed)) throw listed.error;
    expect(listed.value.map((entry) => entry.name)).toEqual([
      "Untitled.md",
      "Untitled copy.md",
      "Untitled copy 2.md",
    ]);
  });

  it("duplicates a diagram with its source, under a free copy name", async () => {
    const repo = makeRepo();
    const project = await repo.createProject("Docs");
    if (!isOk(project)) throw project.error;
    const diagram = await repo.createEmptyDiagram(project.value.id);
    if (!isOk(diagram)) throw diagram.error;
    const saved = await repo.saveDiagramFile(project.value.id, {
      ...diagram.value,
      source: "title Flow\nA -> B: hi",
    });
    if (!isOk(saved)) throw saved.error;

    const copy = await repo.duplicateDiagramFile(
      project.value.id,
      saved.value.id,
    );
    if (!isOk(copy)) throw copy.error;
    expect(copy.value.id).not.toBe(saved.value.id);
    expect(copy.value.name).toBe("Untitled copy");
    expect(copy.value.source).toBe("title Flow\nA -> B: hi");
    expect(copy.value.projectId).toBe(project.value.id);

    const listed = await repo.listDiagramFiles(project.value.id);
    if (!isOk(listed)) throw listed.error;
    expect(listed.value.map((entry) => entry.name)).toEqual([
      "Untitled",
      "Untitled copy",
    ]);
  });

  it("refuses to duplicate an unknown file", async () => {
    const { repo, projectId } = await withNote();
    const missingNote = await repo.duplicateNoteFile(projectId, "note-nope");
    expect(isOk(missingNote)).toBe(false);
    const missingDiagram = await repo.duplicateDiagramFile(
      projectId,
      "diag-nope",
    );
    expect(isOk(missingDiagram)).toBe(false);
  });

  it("includes notes in the workspace snapshot", async () => {
    const { repo, note } = await withNote();
    const snapshot = await repo.listAll();
    if (!isOk(snapshot)) throw snapshot.error;
    expect(snapshot.value.notes?.map((entry) => entry.id)).toEqual([note.id]);
  });

  it("keeps note and diagram lists separate in one project", async () => {
    const { repo, projectId, note } = await withNote();
    const diagram = await repo.createEmptyDiagram(projectId);
    if (!isOk(diagram)) throw diagram.error;

    const diagrams = await repo.listDiagramFiles(projectId);
    const notes = await repo.listNoteFiles(projectId);
    if (!isOk(diagrams) || !isOk(notes)) throw new Error("list failed");
    expect(diagrams.value.map((entry) => entry.id)).toEqual([diagram.value.id]);
    expect(notes.value.map((entry) => entry.id)).toEqual([note.id]);
  });
});
