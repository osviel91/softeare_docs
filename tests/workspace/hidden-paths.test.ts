import { describe, expect, it } from "vitest";
import {
  createInMemoryHiddenPathStore,
  createLocalStorageHiddenPathStore,
  hiddenPathsStorageKey,
  isHidden,
  type StorageLike,
} from "../../src/workspace/hidden-paths";

describe("isHidden", () => {
  it("matches a directly hidden path", () => {
    expect(
      isHidden(new Set(["onboarding/welcome.seq"]), "onboarding/welcome.seq"),
    ).toBe(true);
  });

  it("hides every descendant of a hidden directory", () => {
    // Hiding a project must hide the diagrams inside it.
    const hidden = new Set(["onboarding"]);
    expect(isHidden(hidden, "onboarding/welcome.seq")).toBe(true);
    expect(isHidden(hidden, "onboarding/nested/deep.seq")).toBe(true);
  });

  it("does not hide siblings or unrelated paths", () => {
    const hidden = new Set(["onboarding"]);
    expect(isHidden(hidden, "onboarding-2/welcome.seq")).toBe(false);
    expect(isHidden(hidden, "work/report.seq")).toBe(false);
  });

  it("normalizes the probed path before matching", () => {
    expect(isHidden(new Set(["a/b"]), "a//b")).toBe(true);
  });

  it("treats the empty path as never hidden", () => {
    expect(isHidden(new Set([""]), "")).toBe(false);
  });
});

describe("in-memory hidden path store", () => {
  it("starts empty", () => {
    expect(createInMemoryHiddenPathStore().list()).toEqual([]);
  });

  it("hides, lists, unhides, and clears", () => {
    const store = createInMemoryHiddenPathStore();
    store.hide("onboarding/welcome.seq");
    expect(store.list()).toEqual(["onboarding/welcome.seq"]);
    store.unhide("onboarding/welcome.seq");
    expect(store.list()).toEqual([]);

    store.hide("a");
    store.hide("b");
    store.clear();
    expect(store.list()).toEqual([]);
  });

  it("normalizes paths and ignores an empty path", () => {
    const store = createInMemoryHiddenPathStore();
    store.hide("a//b/");
    store.hide("");
    expect(store.list()).toEqual(["a/b"]);
  });

  it("is idempotent", () => {
    const store = createInMemoryHiddenPathStore();
    store.hide("a");
    store.hide("a");
    expect(store.list()).toEqual(["a"]);
  });
});

describe("localStorage hidden path store", () => {
  /** A minimal Web Storage double; jsdom's `localStorage` is not always present. */
  class FakeStorage implements StorageLike {
    private values = new Map<string, string>();

    getItem(key: string): string | null {
      return this.values.has(key) ? (this.values.get(key) as string) : null;
    }

    setItem(key: string, value: string): void {
      this.values.set(key, value);
    }

    removeItem(key: string): void {
      this.values.delete(key);
    }
  }

  it("persists hidden paths per folder", () => {
    const storage = new FakeStorage();
    const first = createLocalStorageHiddenPathStore("Work", storage);
    first.hide("onboarding/welcome.seq");

    // A second store for the same folder sees the persisted set...
    const reopened = createLocalStorageHiddenPathStore("Work", storage);
    expect(reopened.list()).toEqual(["onboarding/welcome.seq"]);

    // ...while another folder keeps its own key.
    const other = createLocalStorageHiddenPathStore("Personal", storage);
    expect(other.list()).toEqual([]);
    expect(storage.getItem(hiddenPathsStorageKey("Personal"))).toBeNull();
  });

  it("unhides and clears", () => {
    const storage = new FakeStorage();
    const store = createLocalStorageHiddenPathStore("Work", storage);
    store.hide("a");
    store.unhide("a");
    expect(store.list()).toEqual([]);

    store.hide("a");
    store.clear();
    expect(store.list()).toEqual([]);
    expect(storage.getItem(hiddenPathsStorageKey("Work"))).toBeNull();
  });

  it("survives corrupted stored data", () => {
    const storage = new FakeStorage();
    storage.setItem(hiddenPathsStorageKey("Work"), "not json");
    const store = createLocalStorageHiddenPathStore("Work", storage);
    expect(store.list()).toEqual([]);
  });

  it("keeps working in memory when no storage is available", () => {
    // The degraded mode must still hide paths for the session.
    const store = createLocalStorageHiddenPathStore("Work", null);
    store.hide("onboarding/welcome.seq");
    expect(store.list()).toEqual(["onboarding/welcome.seq"]);
    store.unhide("onboarding/welcome.seq");
    expect(store.list()).toEqual([]);
  });
});
