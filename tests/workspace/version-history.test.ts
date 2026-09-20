import { describe, expect, it } from "vitest";
import { MAX_VERSIONS_PER_DIAGRAM } from "../../src/domain/workspace/version";
import { isOk } from "../../src/shared/result/result";
import { createInMemoryVersionHistory } from "../../src/workspace/version-history";

/** Record a version, throwing on failure so tests read linearly. */
async function record(
  store: ReturnType<typeof createInMemoryVersionHistory>,
  diagramId: string,
  source: string,
  label = "checkpoint",
) {
  const result = await store.recordVersion({
    diagramId,
    projectId: "proj-1",
    name: "diagram.seq",
    source,
    label,
  });
  if (!isOk(result)) throw result.error;
  return result.value;
}

describe("in-memory version history", () => {
  it("starts with no versions", async () => {
    const store = createInMemoryVersionHistory();
    const result = await store.listVersions("diag-1");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual([]);
  });

  it("records a version with an id, time, and label", async () => {
    const store = createInMemoryVersionHistory();
    const version = await record(store, "diag-1", "a -> b: hi", "Initial");
    expect(version.id).toMatch(/^ver-/);
    expect(version.diagramId).toBe("diag-1");
    expect(version.label).toBe("Initial");
    expect(version.createdAt).toBeGreaterThan(0);
  });

  it("lists versions newest first", async () => {
    const store = createInMemoryVersionHistory();
    await record(store, "diag-1", "one");
    await record(store, "diag-1", "two");
    const result = await store.listVersions("diag-1");
    if (!isOk(result)) throw result.error;
    expect(result.value.map((version) => version.source)).toEqual([
      "two",
      "one",
    ]);
  });

  it("keeps each diagram's timeline separate", async () => {
    const store = createInMemoryVersionHistory();
    await record(store, "diag-1", "one");
    await record(store, "diag-2", "other");
    const first = await store.listVersions("diag-1");
    if (!isOk(first)) throw first.error;
    expect(first.value).toHaveLength(1);
    expect(first.value[0].source).toBe("one");
  });

  it("does not record a source identical to the newest version", async () => {
    const store = createInMemoryVersionHistory();
    await record(store, "diag-1", "a -> b: hi");
    // Trailing whitespace is not an edit.
    const again = await record(store, "diag-1", "a -> b: hi\n");
    const result = await store.listVersions("diag-1");
    if (!isOk(result)) throw result.error;
    expect(result.value).toHaveLength(1);
    // The existing newest version is returned rather than a new one.
    expect(again.id).toBe(result.value[0].id);
  });

  it("caps the timeline at the configured maximum", async () => {
    const store = createInMemoryVersionHistory();
    for (let i = 0; i < MAX_VERSIONS_PER_DIAGRAM + 5; i++) {
      await record(store, "diag-1", `source ${i}`);
    }
    const result = await store.listVersions("diag-1");
    if (!isOk(result)) throw result.error;
    expect(result.value).toHaveLength(MAX_VERSIONS_PER_DIAGRAM);
    // The oldest entries were pruned; the newest survived.
    expect(result.value[0].source).toBe(
      `source ${MAX_VERSIONS_PER_DIAGRAM + 4}`,
    );
  });

  it("returns a copy so callers cannot mutate the stored timeline", async () => {
    const store = createInMemoryVersionHistory();
    await record(store, "diag-1", "one");
    const first = await store.listVersions("diag-1");
    if (!isOk(first)) throw first.error;
    first.value.pop();
    const second = await store.listVersions("diag-1");
    if (!isOk(second)) throw second.error;
    expect(second.value).toHaveLength(1);
  });

  it("deletes a single version", async () => {
    const store = createInMemoryVersionHistory();
    const kept = await record(store, "diag-1", "one");
    const removed = await record(store, "diag-1", "two");
    const deletion = await store.deleteVersion(removed.id);
    expect(isOk(deletion)).toBe(true);
    const result = await store.listVersions("diag-1");
    if (!isOk(result)) throw result.error;
    expect(result.value.map((version) => version.id)).toEqual([kept.id]);
  });

  it("clears one diagram's timeline", async () => {
    const store = createInMemoryVersionHistory();
    await record(store, "diag-1", "one");
    await record(store, "diag-2", "two");
    await store.clearDiagram("diag-1");
    const cleared = await store.listVersions("diag-1");
    const intact = await store.listVersions("diag-2");
    if (!isOk(cleared) || !isOk(intact)) throw new Error("list failed");
    expect(cleared.value).toEqual([]);
    expect(intact.value).toHaveLength(1);
  });

  it("clears every timeline in a project", async () => {
    const store = createInMemoryVersionHistory();
    await store.recordVersion({
      diagramId: "diag-1",
      projectId: "proj-1",
      name: "a.seq",
      source: "one",
      label: "x",
    });
    await store.recordVersion({
      diagramId: "diag-2",
      projectId: "proj-2",
      name: "b.seq",
      source: "two",
      label: "x",
    });
    await store.clearProject("proj-1");
    const cleared = await store.listVersions("diag-1");
    const intact = await store.listVersions("diag-2");
    if (!isOk(cleared) || !isOk(intact)) throw new Error("list failed");
    expect(cleared.value).toEqual([]);
    expect(intact.value).toHaveLength(1);
  });
});
