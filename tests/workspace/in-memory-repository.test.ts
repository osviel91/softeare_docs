import { beforeEach, describe, expect, it } from "vitest";
import type { DiagramFile } from "../../src/domain/workspace/types";
import { isOk } from "../../src/shared/result/result";
import { createInMemoryWorkspaceRepository } from "../../src/workspace/in-memory";
import type { WorkspaceRepository } from "../../src/workspace/WorkspaceRepository";

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
});
