import { describe, expect, it } from "vitest";
import type { DiagramFile } from "../../../src/domain/workspace/types";
import {
  activateDiagram,
  closeDiagram,
  createEmptyTabSet,
  getActiveTab,
  hasTab,
  openDiagram,
  updateTabSource,
  type TabSet,
} from "../../../src/features/tabs/tabs";

const diagram = (
  id: string,
  source = `title ${id}\nA -> B: hi`,
  name?: string,
): DiagramFile => ({
  id,
  name: name ?? id,
  source,
  projectId: "proj-1",
});

const empty = (): TabSet => createEmptyTabSet();

describe("tab-set model", () => {
  it("starts empty with no active tab", () => {
    const set = empty();
    expect(set.tabs).toEqual([]);
    expect(set.activeTabId).toBeNull();
    expect(getActiveTab(set)).toBeNull();
  });

  it("opens a new diagram as the active tab", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    expect(set.tabs).toHaveLength(1);
    expect(set.activeTabId).toBe("diag-1");
    expect(getActiveTab(set)?.source).toBe(diagram("diag-1").source);
  });

  it("activates an already-open tab without duplicating it", () => {
    let set = openDiagram(empty(), diagram("diag-1"));
    set = openDiagram(set, diagram("diag-2"));
    set = openDiagram(set, diagram("diag-1"));
    expect(set.tabs).toHaveLength(2);
    expect(set.activeTabId).toBe("diag-1");
  });

  it("reports whether a diagram is open", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    expect(hasTab(set, "diag-1")).toBe(true);
    expect(hasTab(set, "diag-2")).toBe(false);
  });

  it("activates an open tab", () => {
    let set = openDiagram(empty(), diagram("diag-1"));
    set = openDiagram(set, diagram("diag-2"));
    set = activateDiagram(set, "diag-1");
    expect(set.activeTabId).toBe("diag-1");
  });

  it("does not activate a diagram that is not open", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    const next = activateDiagram(set, "diag-2");
    expect(next).toBe(set);
    expect(next.activeTabId).toBe("diag-1");
  });

  it("replaces the active tab's buffer on source update", () => {
    let set = openDiagram(empty(), diagram("diag-1"));
    set = updateTabSource(set, "diag-1", "participant A");
    expect(getActiveTab(set)?.source).toBe("participant A");
  });

  it("ignores source updates for an unknown tab", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    const next = updateTabSource(set, "diag-2", "x");
    expect(next).toBe(set);
  });

  it("closes the active tab and switches to the previous one", () => {
    let set = openDiagram(empty(), diagram("diag-1"));
    set = openDiagram(set, diagram("diag-2"));
    set = openDiagram(set, diagram("diag-3"));
    // Close diag-3: the previous tab (diag-2) becomes active.
    set = closeDiagram(set, "diag-3");
    expect(getActiveTab(set)?.id).toBe("diag-2");
    expect(hasTab(set, "diag-3")).toBe(false);
  });

  it("closes the active tab and falls back to the first when no previous exists", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    const next = closeDiagram(set, "diag-1");
    expect(next.activeTabId).toBeNull();
    expect(next.tabs).toHaveLength(0);
  });

  it("keeps the active tab unchanged when a non-active tab is closed", () => {
    let set = openDiagram(empty(), diagram("diag-1"));
    set = openDiagram(set, diagram("diag-2"));
    set = closeDiagram(set, "diag-1");
    expect(getActiveTab(set)?.id).toBe("diag-2");
  });

  it("ignores closing an unknown tab", () => {
    const set = openDiagram(empty(), diagram("diag-1"));
    const next = closeDiagram(set, "diag-9");
    expect(next).toBe(set);
  });
});
