import { describe, expect, it, vi } from "vitest";
import { MAX_VERSIONS_PER_DIAGRAM } from "../../src/domain/workspace/version";
import { isOk } from "../../src/shared/result/result";
import { createIndexedDbVersionHistory } from "../../src/workspace/version-history-idb";
import type { VersionHistoryStore } from "../../src/workspace/version-history";
import { FakeFactory } from "./fake-idb";

/** Build a store over a fresh in-memory database. */
function newStore(): VersionHistoryStore {
  return createIndexedDbVersionHistory(new FakeFactory());
}

/** Record a version, throwing on failure so tests read linearly. */
async function record(
  store: VersionHistoryStore,
  diagramId: string,
  source: string,
  projectId = "proj-1",
) {
  const result = await store.recordVersion({
    diagramId,
    projectId,
    name: "diagram.seq",
    source,
    label: "checkpoint",
  });
  if (!isOk(result)) throw result.error;
  return result.value;
}

describe("IndexedDB version history", () => {
  it("starts empty", async () => {
    const result = await newStore().listVersions("diag-1");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual([]);
  });

  it("records and lists versions newest first", async () => {
    const store = newStore();
    await record(store, "diag-1", "one");
    await record(store, "diag-1", "two");
    const result = await store.listVersions("diag-1");
    if (!isOk(result)) throw result.error;
    expect(result.value.map((version) => version.source)).toEqual([
      "two",
      "one",
    ]);
  });

  it("persists across store instances sharing a factory", async () => {
    const factory = new FakeFactory();
    const first = createIndexedDbVersionHistory(factory);
    await record(first, "diag-1", "one");
    const second = createIndexedDbVersionHistory(factory);
    const result = await second.listVersions("diag-1");
    if (!isOk(result)) throw result.error;
    expect(result.value).toHaveLength(1);
  });

  it("does not re-record an identical source", async () => {
    const store = newStore();
    const original = await record(store, "diag-1", "a -> b: hi");
    const again = await record(store, "diag-1", "a -> b: hi\n");
    expect(again.id).toBe(original.id);
    const result = await store.listVersions("diag-1");
    if (!isOk(result)) throw result.error;
    expect(result.value).toHaveLength(1);
  });

  it("prunes the oldest versions beyond the cap", async () => {
    const store = newStore();
    for (let i = 0; i < MAX_VERSIONS_PER_DIAGRAM + 3; i++) {
      await record(store, "diag-1", `source ${i}`);
    }
    const result = await store.listVersions("diag-1");
    if (!isOk(result)) throw result.error;
    expect(result.value).toHaveLength(MAX_VERSIONS_PER_DIAGRAM);
    expect(result.value[0].source).toBe(
      `source ${MAX_VERSIONS_PER_DIAGRAM + 2}`,
    );
  });

  it("keeps timelines of different diagrams separate", async () => {
    const store = newStore();
    await record(store, "diag-1", "one");
    await record(store, "diag-2", "two");
    const first = await store.listVersions("diag-1");
    if (!isOk(first)) throw first.error;
    expect(first.value.map((version) => version.source)).toEqual(["one"]);
  });

  it("lists one project's versions across its diagrams, newest first", async () => {
    const store = newStore();
    // Distinct times so "newest first" is unambiguous across diagrams.
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 10));
    try {
      await record(store, "diag-1", "first", "proj-1");
      await record(store, "diag-2", "second", "proj-1");
      await record(store, "diag-9", "other-project", "proj-2");
    } finally {
      clock.mockRestore();
    }

    const result = await store.listProjectVersions("proj-1");
    if (!isOk(result)) throw result.error;
    expect(result.value.map((version) => version.source)).toEqual([
      "second",
      "first",
    ]);
    expect(result.value.every((v) => v.projectId === "proj-1")).toBe(true);
  });

  it("deletes a single version", async () => {
    const store = newStore();
    const kept = await record(store, "diag-1", "one");
    const removed = await record(store, "diag-1", "two");
    await store.deleteVersion(removed.id);
    const result = await store.listVersions("diag-1");
    if (!isOk(result)) throw result.error;
    expect(result.value.map((version) => version.id)).toEqual([kept.id]);
  });

  it("clears one diagram's timeline", async () => {
    const store = newStore();
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
    const store = newStore();
    await record(store, "diag-1", "one", "proj-1");
    await record(store, "diag-2", "two", "proj-2");
    await store.clearProject("proj-1");
    const cleared = await store.listVersions("diag-1");
    const intact = await store.listVersions("diag-2");
    if (!isOk(cleared) || !isOk(intact)) throw new Error("list failed");
    expect(cleared.value).toEqual([]);
    expect(intact.value).toHaveLength(1);
  });
});
