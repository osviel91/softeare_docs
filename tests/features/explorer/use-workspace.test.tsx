import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useWorkspace } from "../../../src/features/explorer/use-workspace";
import { createInMemoryWorkspaceRepository } from "../../../src/workspace/in-memory";
import type { WorkspaceRepository } from "../../../src/workspace/WorkspaceRepository";

/** A resource's stable identity as one project's metadata records it. */
interface Identity {
  id: string;
  path: string;
}

/** The identity records a project's metadata document holds, or `null`. */
async function identities(
  repo: WorkspaceRepository,
  projectId: string,
): Promise<Identity[] | null> {
  const result = await repo.readProjectMetadata(projectId);
  if (!result.ok || !result.value) return null;
  return result.value.resources.map((resource) => ({
    id: resource.id,
    path: resource.path,
  }));
}

/** Create a project through the hook, wait for it, and return its id. */
async function createProject(
  hook: ReturnType<typeof renderHook<ReturnType<typeof useWorkspace>, unknown>>,
  name: string,
): Promise<string> {
  await act(async () => {
    await hook.result.current.createProject(name);
  });
  await waitFor(() => {
    expect(hook.result.current.projects.some((p) => p.name === name)).toBe(
      true,
    );
  });
  return hook.result.current.projects.find((p) => p.name === name)!.id;
}

describe("useWorkspace — a file in a project that is not selected", () => {
  it("renames it without moving the other project's resource identity", async () => {
    const repo = createInMemoryWorkspaceRepository();
    const hook = renderHook(() => useWorkspace(repo));

    // Default owns one file, named "Untitled" (id `diagram-untitled`).
    const defaultId = await createProject(hook, "Default");
    await act(async () => {
      await hook.result.current.createEmptyDiagram(defaultId);
    });

    // Project2 owns two files, one of which ends up at the path "Untitled" but
    // carries the identity minted for a different path. That divergence is what
    // a rename keyed on the wrong project's document would move across.
    const project2Id = await createProject(hook, "Project2");
    let firstId = "";
    let secondId = "";
    await act(async () => {
      firstId = (await hook.result.current.createEmptyDiagram(project2Id))!.id;
    });
    await act(async () => {
      secondId = (await hook.result.current.createEmptyDiagram(project2Id))!.id;
    });
    await act(async () => {
      await hook.result.current.renameDiagram(project2Id, firstId, "beta");
    });
    await act(async () => {
      await hook.result.current.renameDiagram(project2Id, secondId, "Untitled");
    });

    // Project2 is selected, so its document is the one held in memory.
    await waitFor(async () => {
      expect(await identities(repo, project2Id)).toEqual([
        { id: "diagram-untitled", path: "beta" },
        { id: "diagram-untitled-2", path: "Untitled" },
      ]);
    });
    expect(hook.result.current.selectedProjectId).toBe(project2Id);

    // Rename Default's file while Project2 is selected.
    const defaultDiagram = hook.result.current.allDiagrams.find(
      (diagram) => diagram.projectId === defaultId,
    )!;
    await act(async () => {
      await hook.result.current.renameDiagram(
        defaultId,
        defaultDiagram.id,
        "renamed",
      );
    });

    // Default follows its own file to the new path, keeping its own id, and
    // Project2's identities are untouched. A rename that used the selected
    // project's document would give Default Project2's id and hand Project2 a
    // fresh one, silently breaking every `resource://` link to either file.
    await waitFor(async () => {
      expect(await identities(repo, defaultId)).toEqual([
        { id: "diagram-untitled", path: "renamed" },
      ]);
    });
    expect(await identities(repo, project2Id)).toEqual([
      { id: "diagram-untitled", path: "beta" },
      { id: "diagram-untitled-2", path: "Untitled" },
    ]);
  });
});
