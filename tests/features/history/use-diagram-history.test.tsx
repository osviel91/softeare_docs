import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagramFile } from "../../../src/domain/workspace/types";
import {
  AUTO_CHECKPOINT_DEBOUNCE_MS,
  AUTO_VERSION_LABEL,
  INITIAL_VERSION_LABEL,
  MANUAL_VERSION_LABEL,
} from "../../../src/domain/workspace/version";
import {
  useDiagramHistory,
  type DiagramHistoryHook,
} from "../../../src/features/history/use-diagram-history";
import { isOk } from "../../../src/shared/result/result";
import {
  createInMemoryVersionHistory,
  type VersionHistoryStore,
} from "../../../src/workspace/version-history";

const DIAGRAM: DiagramFile = {
  id: "diag-1",
  name: "diagram.seq",
  source: "title One\nA -> B: hi",
  projectId: "proj-1",
};

/** The latest hook value, captured on every render for assertions. */
const hookRef: { current: DiagramHistoryHook | null } = { current: null };

/** A minimal host that renders the hook under test. */
function Harness({
  store,
  diagram,
  source,
}: {
  store: VersionHistoryStore;
  diagram: DiagramFile | null;
  source: string | null;
}) {
  hookRef.current = useDiagramHistory(store, diagram, source);
  return <span data-testid="count">{hookRef.current.versions.length}</span>;
}

/** Read a diagram's timeline straight from the store. */
async function timeline(store: VersionHistoryStore, diagramId: string) {
  const result = await store.listVersions(diagramId);
  if (!isOk(result)) throw result.error;
  return result.value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useDiagramHistory", () => {
  it("records an initial version when a diagram is first opened", async () => {
    const store = createInMemoryVersionHistory();
    render(<Harness store={store} diagram={DIAGRAM} source={DIAGRAM.source} />);

    await waitFor(() => expect(hookRef.current?.versions).toHaveLength(1));
    expect(hookRef.current?.versions[0].label).toBe(INITIAL_VERSION_LABEL);
    expect(hookRef.current?.versions[0].source).toBe(DIAGRAM.source);
  });

  it("records nothing without a diagram", async () => {
    const store = createInMemoryVersionHistory();
    render(<Harness store={store} diagram={null} source={null} />);
    await act(async () => {});
    expect(hookRef.current?.versions).toEqual([]);
  });

  it("checkpoints automatically after edits settle", async () => {
    vi.useFakeTimers();
    const store = createInMemoryVersionHistory();
    const { rerender } = render(
      <Harness store={store} diagram={DIAGRAM} source={DIAGRAM.source} />,
    );

    // Flush the initial-version write.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(await timeline(store, DIAGRAM.id)).toHaveLength(1);

    // An edit that rests for the debounce window becomes a checkpoint.
    rerender(
      <Harness
        store={store}
        diagram={DIAGRAM}
        source={"title One\nA -> B: bye"}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_CHECKPOINT_DEBOUNCE_MS + 50);
    });

    const versions = await timeline(store, DIAGRAM.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].label).toBe(AUTO_VERSION_LABEL);
    expect(versions[0].source).toBe("title One\nA -> B: bye");
  });

  it("does not checkpoint when the buffer has not changed", async () => {
    vi.useFakeTimers();
    const store = createInMemoryVersionHistory();
    render(<Harness store={store} diagram={DIAGRAM} source={DIAGRAM.source} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_CHECKPOINT_DEBOUNCE_MS * 3);
    });
    expect(await timeline(store, DIAGRAM.id)).toHaveLength(1);
  });

  it("captures a manual checkpoint on demand", async () => {
    const store = createInMemoryVersionHistory();
    render(<Harness store={store} diagram={DIAGRAM} source={DIAGRAM.source} />);
    await waitFor(() => expect(hookRef.current?.versions).toHaveLength(1));

    await act(async () => {
      await hookRef.current?.saveVersion("title Two\nA -> B: hi");
    });

    const versions = await timeline(store, DIAGRAM.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].label).toBe(MANUAL_VERSION_LABEL);
    expect(versions[0].source).toBe("title Two\nA -> B: hi");
  });

  it("accepts a custom label for a restore checkpoint", async () => {
    const store = createInMemoryVersionHistory();
    render(<Harness store={store} diagram={DIAGRAM} source={DIAGRAM.source} />);
    await waitFor(() => expect(hookRef.current?.versions).toHaveLength(1));

    await act(async () => {
      await hookRef.current?.saveVersion("old source", "Restored from history");
    });
    const versions = await timeline(store, DIAGRAM.id);
    expect(versions[0].label).toBe("Restored from history");
  });

  it("forgets a version", async () => {
    const store = createInMemoryVersionHistory();
    render(<Harness store={store} diagram={DIAGRAM} source={DIAGRAM.source} />);
    await waitFor(() => expect(hookRef.current?.versions).toHaveLength(1));
    await act(async () => {
      await hookRef.current?.saveVersion("second");
    });
    await waitFor(() => expect(hookRef.current?.versions).toHaveLength(2));

    const target = hookRef.current!.versions[1];
    await act(async () => {
      await hookRef.current?.removeVersion(target.id);
    });
    await waitFor(() => expect(hookRef.current?.versions).toHaveLength(1));
    expect(hookRef.current?.versions[0].id).not.toBe(target.id);
  });

  it("clears a diagram timeline and a project timeline", async () => {
    const store = createInMemoryVersionHistory();
    render(<Harness store={store} diagram={DIAGRAM} source={DIAGRAM.source} />);
    await waitFor(() => expect(hookRef.current?.versions).toHaveLength(1));

    await act(async () => {
      await hookRef.current?.clearDiagram(DIAGRAM.id);
    });
    await waitFor(() => expect(hookRef.current?.versions).toHaveLength(0));
    expect(await timeline(store, DIAGRAM.id)).toEqual([]);

    // Recording again, then clearing by project, empties it too.
    await act(async () => {
      await hookRef.current?.saveVersion("fresh source");
    });
    await waitFor(() => expect(hookRef.current?.versions).toHaveLength(1));
    await act(async () => {
      await hookRef.current?.clearProject(DIAGRAM.projectId);
    });
    expect(await timeline(store, DIAGRAM.id)).toEqual([]);
  });
});
