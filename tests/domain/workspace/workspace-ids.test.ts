import { describe, expect, it } from "vitest";
import {
  newDiagramFileId,
  newProjectId,
  testWorkspaceIdFactory,
} from "../../../src/domain/workspace/workspace-ids";

describe("workspace ids", () => {
  it("gives project ids a proj- prefix", () => {
    expect(newProjectId()).toMatch(/^proj-/);
  });

  it("gives diagram ids a diag- prefix", () => {
    expect(newDiagramFileId()).toMatch(/^diag-/);
  });

  it("produces unique ids across calls", () => {
    const first = newProjectId();
    const second = newProjectId();
    expect(first).not.toBe(second);

    const diagramFirst = newDiagramFileId();
    const diagramSecond = newDiagramFileId();
    expect(diagramFirst).not.toBe(diagramSecond);
  });

  it("runs project and diagram counters independently", () => {
    const factory = testWorkspaceIdFactory();
    expect(factory.newProjectId()).toBe("id-proj-0");
    expect(factory.newDiagramFileId()).toBe("id-diag-0");
    expect(factory.newProjectId()).toBe("id-proj-1");
    expect(factory.newDiagramFileId()).toBe("id-diag-1");
  });

  it("honors a custom prefix", () => {
    const factory = testWorkspaceIdFactory("seed");
    expect(factory.newProjectId()).toBe("seed-proj-0");
    expect(factory.newDiagramFileId()).toBe("seed-diag-0");
  });
});
