import { beforeEach, describe, expect, it } from "vitest";
import {
  PROJECT_METADATA_FORMAT,
  PROJECT_METADATA_VERSION,
  createEmptyMetadata,
  type ProjectMetadata,
} from "../../src/domain/workspace/metadata";
import type { DiagramFile } from "../../src/domain/workspace/types";
import { isOk } from "../../src/shared/result/result";
import { createInMemoryWorkspaceRepository } from "../../src/workspace/in-memory";
import type { WorkspaceRepository } from "../../src/workspace/WorkspaceRepository";

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

describe("In-memory workspace repository", () => {
  let repo: WorkspaceRepository;

  beforeEach(() => {
    repo = createInMemoryWorkspaceRepository();
  });

  it("starts empty", async () => {
    const result = await repo.listProjects();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual([]);
    }
  });

  it("renames a project without changing its id or files", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const project = created.value;
    await repo.createEmptyDiagram(project.id);

    const renamed = await repo.renameProject(project.id, "  Getting started  ");
    expect(isOk(renamed)).toBe(true);
    if (!isOk(renamed)) return;
    // The stored name is trimmed; the generated id is untouched.
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

  it("refuses to rename a project to a blank name or one that is missing", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;

    const blank = await repo.renameProject(created.value.id, "   ");
    expect(isOk(blank)).toBe(false);

    const missing = await repo.renameProject("proj-missing", "Anything");
    expect(isOk(missing)).toBe(false);
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
      // A fresh id is generated and differs from the project id.
      expect(result.value.id.startsWith("diag-")).toBe(true);
      createdId = result.value.id;
    }

    // The new file appears in the project's diagram list.
    const listed = await repo.listDiagramFiles(projectId);
    if (isOk(listed)) {
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0].id).toBe(createdId);
    }
  });

  it("creates several empty diagrams with unique ids", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;

    const first = await repo.createEmptyDiagram(projectId);
    const second = await repo.createEmptyDiagram(projectId);
    if (isOk(first) && isOk(second)) {
      expect(first.value.id).not.toBe(second.value.id);
    }
  });

  it("returns an error for an unknown project", async () => {
    const result = await repo.createEmptyDiagram("does-not-exist");
    expect(isOk(result)).toBe(false);
    if (!isOk(result)) {
      expect(result.error.message).toContain("does-not-exist");
    }
  });

  it("links a created diagram so deleting the project removes it", async () => {
    const created = await repo.createProject("Onboarding");
    if (isOk(created)) {
      const projectId = created.value.id;
      const result = await repo.createEmptyDiagram(projectId);
      if (isOk(result)) {
        const diagram: DiagramFile = result.value;
        await repo.deleteProject(projectId);
        const fetched = await repo.getDiagramFile(projectId, diagram.id);
        expect(isOk(fetched)).toBe(true);
        if (isOk(fetched)) expect(fetched.value).toBeNull();
      }
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

  it("does not hand out its stored metadata by reference", async () => {
    const created = await repo.createProject("Onboarding");
    if (!isOk(created)) throw created.error;
    const projectId = created.value.id;
    await repo.writeProjectMetadata(projectId, createEmptyMetadata());

    const read = await repo.readProjectMetadata(projectId);
    if (!isOk(read) || !read.value) throw new Error("metadata missing");
    read.value.resources.push({
      id: "diagram-leaked",
      path: "leaked.seq",
      type: "sequence-diagram",
    });

    const again = await repo.readProjectMetadata(projectId);
    if (!isOk(again)) throw again.error;
    expect(again.value?.resources).toEqual([]);
  });
});
