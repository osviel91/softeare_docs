import { describe, expect, it } from "vitest";
import { loadProjectSnapshot } from "../../src/services/project-service";
import { isOk } from "../../src/shared/result/result";
import { createInMemoryWorkspaceRepository } from "../../src/workspace/in-memory";

describe("project service resource types", () => {
  /**
   * The identity record is what the project index reads, so a mis-typed record
   * means a document is analysed as the wrong language. A diagram's type comes
   * from its extension (ADR-028); a note's comes from the store it lives in,
   * because an in-browser note need not carry `.md`.
   */
  it("types a diagram by its extension and a note by its store", async () => {
    const repo = createInMemoryWorkspaceRepository();
    const created = await repo.createProject("Docs");
    if (!isOk(created)) throw created.error;
    const project = created.value;

    await repo.saveDiagramFile(project.id, {
      id: "d1",
      name: "orders.eventseq",
      source: "event OrderCreated",
      projectId: project.id,
    });
    await repo.saveDiagramFile(project.id, {
      id: "d2",
      name: "checkout.seq",
      source: "title Checkout",
      projectId: project.id,
    });
    await repo.saveNoteFile(project.id, {
      id: "n1",
      name: "Readme",
      markdown: "# Readme",
      projectId: project.id,
    });

    const snapshot = await loadProjectSnapshot(repo, project);
    if (!isOk(snapshot)) throw snapshot.error;
    const typeOf = (path: string): string | undefined =>
      snapshot.value.metadata.resources.find(
        (resource) => resource.path === path,
      )?.type;

    expect(typeOf("orders.eventseq")).toBe("event-flow");
    expect(typeOf("checkout.seq")).toBe("sequence-diagram");
    expect(typeOf("Readme")).toBe("markdown-document");
  });
});
