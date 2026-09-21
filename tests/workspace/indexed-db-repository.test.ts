import { beforeEach, describe, expect, it } from "vitest";
import {
  PROJECT_METADATA_FORMAT,
  PROJECT_METADATA_VERSION,
  createEmptyMetadata,
  type ProjectMetadata,
} from "../../src/domain/workspace/metadata";
import type { DiagramFile } from "../../src/domain/workspace/types";
import { testWorkspaceIdFactory } from "../../src/domain/workspace/workspace-ids";
import { isOk } from "../../src/shared/result/result";
import type { IdbFactory } from "../../src/workspace/idb-adapter";
import { createIndexedDbRepository } from "../../src/workspace/indexed-db";
import type { WorkspaceRepository } from "../../src/workspace/WorkspaceRepository";
import { FakeFactory } from "./fake-idb";

/** A minimal, well-formed metadata document with one recorded diagram. */
function sampleMetadata(): ProjectMetadata {
  return {
    format: PROJECT_METADATA_FORMAT,
    version: PROJECT_METADATA_VERSION,
    resources: [
      {
        id: "diagram-welcome",
        path: "welcome.seq",
        type: "sequence-diagram",
        title: "Welcome",
      },
    ],
  };
}

describe("IndexedDB workspace repository", () => {
  let repo: WorkspaceRepository;
  let ids: ReturnType<typeof testWorkspaceIdFactory>;

  beforeEach(() => {
    repo = createIndexedDbRepository(new FakeFactory());
    ids = testWorkspaceIdFactory();
  });

  it("starts empty", async () => {
    const result = await repo.listProjects();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual([]);
    }
  });

  it("creates a project with a fresh id and no diagrams", async () => {
    const result = await repo.createProject("Onboarding");
    if (!isOk(result)) throw result.error;
    const createdId = result.value.id;
    expect(result.value.name).toBe("Onboarding");
    expect(result.value.datasetIds).toEqual([]);

    const listed = await repo.listProjects();
    if (isOk(listed)) {
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0].id).toBe(createdId);
    }
  });

  it("returns null for an unknown project", async () => {
    const result = await repo.getProject("does-not-exist");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBeNull();
    }
  });

  it("renames a project in place and keeps its files", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const project = created.value;
    await repo.createEmptyDiagram(project.id);

    const renamed = await repo.renameProject(project.id, "Getting started");
    if (!isOk(renamed)) throw renamed.error;
    // The generated id is what the files point at, so it must not move.
    expect(renamed.value).toMatchObject({
      id: project.id,
      name: "Getting started",
    });

    const listed = await repo.listProjects();
    if (isOk(listed)) {
      expect(listed.value[0].name).toBe("Getting started");
    }
    const files = await repo.listDiagramFiles(project.id);
    if (isOk(files)) {
      expect(files.value).toHaveLength(1);
    }
  });

  it("refuses a blank rename and reports an unknown project", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;

    expect(isOk(await repo.renameProject(created.value.id, "   "))).toBe(false);
    expect(isOk(await repo.renameProject("missing", "Anything"))).toBe(false);
  });

  it("stores a diagram and links it to the project", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;

    const diagram: DiagramFile = {
      id: ids.newDiagramFileId(),
      name: "Welcome",
      source: "title Welcome\nA -> B: hi",
      projectId,
    };
    const saved = await repo.saveDiagramFile(projectId, diagram);
    expect(isOk(saved)).toBe(true);

    const listed = await repo.listDiagramFiles(projectId);
    if (isOk(listed)) {
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0]).toEqual(diagram);
    }

    const fetched = await repo.getDiagramFile(projectId, diagram.id);
    if (isOk(fetched)) {
      expect(fetched.value).toEqual(diagram);
    }
  });

  it("enforces that a diagram belongs to exactly one project", async () => {
    const first = await repo.createProject("First");
    if (!isOk(first)) throw first.error;
    const second = await repo.createProject("Second");
    if (!isOk(second)) throw second.error;

    const diagram: DiagramFile = {
      id: ids.newDiagramFileId(),
      name: "Owned",
      source: "title Owned\nA -> B: hi",
      projectId: first.value.id,
    };
    await repo.saveDiagramFile(first.value.id, diagram);

    // Storing the same file under another project rewrites its projectId.
    const moved = await repo.saveDiagramFile(second.value.id, {
      ...diagram,
      projectId: second.value.id,
    });
    if (isOk(moved)) {
      expect(moved.value.projectId).toBe(second.value.id);
    }

    // The file no longer belongs to the original project.
    const fromFirst = await repo.getDiagramFile(first.value.id, diagram.id);
    expect(isOk(fromFirst)).toBe(true);
    if (isOk(fromFirst)) {
      expect(fromFirst.value).toBeNull();
    }
  });

  it("returns diagrams in insertion (display) order", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;

    const first = {
      id: ids.newDiagramFileId(),
      name: "A",
      source: "s1",
      projectId,
    };
    const second = {
      id: ids.newDiagramFileId(),
      name: "B",
      source: "s2",
      projectId,
    };
    const third = {
      id: ids.newDiagramFileId(),
      name: "C",
      source: "s3",
      projectId,
    };

    await repo.saveDiagramFile(projectId, first);
    await repo.saveDiagramFile(projectId, second);
    await repo.saveDiagramFile(projectId, third);

    const list = await repo.listDiagramFiles(projectId);
    if (isOk(list)) {
      expect(list.value.map((d) => d.id)).toEqual([
        first.id,
        second.id,
        third.id,
      ]);
    }
  });

  it("deletes a diagram and drops it from the project", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;
    const diagram: DiagramFile = {
      id: ids.newDiagramFileId(),
      name: "Welcome",
      source: "title Welcome\nA -> B: hi",
      projectId,
    };
    await repo.saveDiagramFile(projectId, diagram);

    const deleted = await repo.deleteDiagramFile(projectId, diagram.id);
    expect(isOk(deleted)).toBe(true);

    const listed = await repo.listDiagramFiles(projectId);
    if (isOk(listed)) {
      expect(listed.value).toEqual([]);
    }
  });

  it("deletes a project together with its diagrams (no orphans)", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;
    const diagram: DiagramFile = {
      id: ids.newDiagramFileId(),
      name: "Welcome",
      source: "title Welcome\nA -> B: hi",
      projectId,
    };
    await repo.saveDiagramFile(projectId, diagram);

    const deleted = await repo.deleteProject(projectId);
    expect(isOk(deleted)).toBe(true);

    const listed = await repo.listProjects();
    if (isOk(listed)) {
      expect(listed.value).toEqual([]);
    }

    // The diagram is gone, and a stale id resolves to null.
    const remaining = await repo.listAll();
    if (isOk(remaining)) {
      expect(remaining.value.diagrams).toEqual([]);
    }
    const fetched = await repo.getDiagramFile(projectId, diagram.id);
    expect(isOk(fetched)).toBe(true);
    if (isOk(fetched)) {
      expect(fetched.value).toBeNull();
    }
  });

  it("creates an empty diagram in a project with a fresh id", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;

    const result = await repo.createEmptyDiagram(projectId);
    expect(isOk(result)).toBe(true);
    let createdId: string | undefined;
    if (isOk(result)) {
      expect(result.value.name).toBe("Untitled");
      expect(result.value.source).toBe("");
      expect(result.value.projectId).toBe(projectId);
      expect(result.value.id.startsWith("diag-")).toBe(true);
      createdId = result.value.id;
    }

    const listed = await repo.listDiagramFiles(projectId);
    if (isOk(listed)) {
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0].id).toBe(createdId);
    }
  });

  it("returns an error for an unknown project", async () => {
    const result = await repo.createEmptyDiagram("does-not-exist");
    expect(isOk(result)).toBe(false);
    if (!isOk(result)) {
      expect(result.error.message).toContain("does-not-exist");
    }
  });

  it("captures the whole workspace as a snapshot", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;
    const diagram: DiagramFile = {
      id: ids.newDiagramFileId(),
      name: "Welcome",
      source: "title Welcome\nA -> B: hi",
      projectId,
    };
    await repo.saveDiagramFile(projectId, diagram);

    const snapshot = await repo.listAll();
    expect(isOk(snapshot)).toBe(true);
    if (isOk(snapshot)) {
      expect(snapshot.value.projects).toHaveLength(1);
      expect(snapshot.value.diagrams).toHaveLength(1);
      expect(snapshot.value.diagrams[0].projectId).toBe(projectId);
    }
  });

  it("surfaces repository errors as a failed Result, not a throw", async () => {
    const rejectingFactory: IdbFactory = {
      open: () => Promise.reject(new Error("boom")),
    };
    const failingRepo = createIndexedDbRepository(rejectingFactory);
    const result = await failingRepo.listProjects();
    expect(isOk(result)).toBe(false);
    if (!isOk(result)) {
      expect(result.error.message).toContain("boom");
    }
  });

  it("round-trips a project's metadata document", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;
    const metadata = sampleMetadata();

    const written = await repo.writeProjectMetadata(projectId, metadata);
    expect(isOk(written)).toBe(true);

    const read = await repo.readProjectMetadata(projectId);
    expect(isOk(read)).toBe(true);
    if (isOk(read)) {
      expect(read.value).toEqual(metadata);
    }
  });

  it("reads null when a project has no metadata yet", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;

    const read = await repo.readProjectMetadata(created.value.id);
    expect(isOk(read)).toBe(true);
    if (isOk(read)) {
      expect(read.value).toBeNull();
    }
  });

  it("returns an error when writing metadata for an unknown project", async () => {
    const written = await repo.writeProjectMetadata(
      "does-not-exist",
      createEmptyMetadata(),
    );
    expect(isOk(written)).toBe(false);
    if (!isOk(written)) {
      expect(written.error.message).toContain("does-not-exist");
    }
  });

  it("drops a project's metadata when the project is deleted", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;
    await repo.writeProjectMetadata(projectId, createEmptyMetadata());

    const deleted = await repo.deleteProject(projectId);
    expect(isOk(deleted)).toBe(true);

    const read = await repo.readProjectMetadata(projectId);
    if (!isOk(read)) throw read.error;
    expect(read.value).toBeNull();
  });

  it("keeps a project's metadata through an unrelated diagram save", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;
    await repo.writeProjectMetadata(projectId, sampleMetadata());

    // Saving a diagram rewrites the project record to link the file; the
    // sidecar must survive that rewrite.
    await repo.saveDiagramFile(projectId, {
      id: ids.newDiagramFileId(),
      name: "Welcome",
      source: "title Welcome\nA -> B: hi",
      projectId,
    });

    const read = await repo.readProjectMetadata(projectId);
    if (!isOk(read)) throw read.error;
    expect(read.value).toEqual(sampleMetadata());
  });
});
