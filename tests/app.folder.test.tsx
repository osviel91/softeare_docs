import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type {
  FsDirectoryHandle,
  FsEntryHandle,
  FsFileHandle,
  FsWritable,
} from "../src/workspace/fs-access/fs-access-adapter";

/** A writable that overwrites its file's source, mirroring the real API. */
class FakeWritable implements FsWritable {
  constructor(private file: FakeFile) {}

  async write(chunk: Uint8Array): Promise<void> {
    this.file.source = new TextDecoder().decode(chunk);
  }

  async close(): Promise<void> {}
}

/**
 * A file entry that models the native `FileSystemFileHandle` driven by the app:
 * its `getFile()` returns a handle whose `arrayBuffer()` yields the file's bytes,
 * which the production adapter decodes via `TextDecoder`. (The repository test's
 * fake returns text directly, since that test drives the adapter interface rather
 * than the native handle.) The bytes come from a `TextEncoder` view because this
 * jsdom build's `Blob` has no `arrayBuffer()`.
 */
class FakeFile {
  readonly kind = "file" as const;
  constructor(
    readonly name: string,
    public source: string,
  ) {}

  async getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    return {
      arrayBuffer: async () =>
        new TextEncoder().encode(this.source).buffer.slice(0),
    };
  }

  async createWritable(): Promise<FsWritable> {
    return new FakeWritable(this);
  }
}

/**
 * A directory entry that lazily creates subdirectories, like the real API.
 *
 * `entries()` is a direct async generator: the real
 * {@link FileSystemDirectoryHandle.entries} is async-iterable, and this is the
 * only shape that the adapter's `for await` accepts in jsdom. It is cast to the
 * native handle type where the picker is driven, so it need not implement the
 * workspace {@link FsDirectoryHandle} contract.
 */
class FakeDirectory {
  readonly kind = "directory" as const;
  public children = new Map<string, FsEntryHandle>();

  constructor(readonly name: string) {}

  async *entries(): AsyncGenerator<[string, FsEntryHandle]> {
    for (const entry of this.children.entries()) {
      yield entry;
    }
  }

  async getFileHandle(
    name: string,
    options?: { createIfNotExists?: boolean },
  ): Promise<FsFileHandle> {
    const existing = this.children.get(name);
    if (existing && existing.kind === "file") return existing;
    if (existing && existing.kind === "directory") {
      throw new Error(`entry exists as directory: ${name}`);
    }
    if (options?.createIfNotExists) {
      const file = new FakeFile(name, "");
      // FakeFile is a native handle (its `getFile()` yields a File-like object),
      // so it is cast here into the adapter contract the repository expects.
      this.children.set(name, file as unknown as FsEntryHandle);
      return file as unknown as FsFileHandle;
    }
    throw new Error(`no such file: ${name}`);
  }

  async getDirectoryHandle(name: string): Promise<FsDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing && existing.kind === "directory") return existing;
    if (existing && existing.kind === "file") {
      throw new Error(`entry exists as file: ${name}`);
    }
    const dir = new FakeDirectory(name);
    // FakeDirectory is decoupled from the workspace adapter contract (its async
    // `entries()` must satisfy the adapter's `for await` in jsdom), so cast it
    // into the map here.
    this.children.set(name, dir as unknown as FsEntryHandle);
    return dir as unknown as FsDirectoryHandle;
  }

  async removeEntry(name: string): Promise<void> {
    this.children.delete(name);
  }
}

/** Build a fake folder tree with one project and diagram, seeded synchronously. */
function buildFakeFolder(): FakeDirectory {
  const root = new FakeDirectory("Test Folder");
  const project = new FakeDirectory("Onboarding");
  project.children.set(
    "welcome.seq",
    new FakeFile(
      "welcome.seq",
      "title Welcome\nA -> B: hi",
    ) as unknown as FsEntryHandle,
  );
  root.children.set("Onboarding", project as unknown as FsEntryHandle);
  return root;
}

let fakeRoot: FakeDirectory;

beforeEach(() => {
  fakeRoot = buildFakeFolder();
  // jsdom has no File System Access API, so define a stub first (this makes the
  // app's feature-detection report the picker as available) and then point the
  // real picker at our fake tree. The rest of the pipeline runs for real:
  // openFileSystemRepository + FileSystemWorkspaceRepository.
  (
    window as typeof window & { showDirectoryPicker?: unknown }
  ).showDirectoryPicker = vi.fn();
  vi.spyOn(window, "showDirectoryPicker").mockResolvedValue(
    fakeRoot as unknown as FileSystemDirectoryHandle,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App — local folder (Phase 5)", () => {
  it("opens a folder through the explorer and shows its name", async () => {
    render(<App />);

    const button = screen.getByTestId("open-folder-button");
    expect(button).toBeEnabled();

    await act(async () => {
      fireEvent.click(button);
    });

    // The folder name flows from the picker into the explorer header.
    await waitFor(() => {
      expect(screen.getByTestId("explorer-mode")).toHaveTextContent(
        "Test Folder",
      );
    });

    // The real repository reads the fake tree, so the seeded project appears.
    await waitFor(() => {
      const projects = screen.getAllByTestId("explorer-project");
      expect(projects).toHaveLength(1);
      expect(projects[0]).toHaveTextContent("Onboarding");
    });
  });

  it("closes the folder and returns to in-browser projects", async () => {
    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("open-folder-button"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("explorer-mode")).toHaveTextContent(
        "Test Folder",
      );
    });

    // The mode now reads "Close folder"; clicking it clears the folder.
    await act(async () => {
      fireEvent.click(screen.getByTestId("open-folder-button"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("explorer-mode")).toHaveTextContent(
        "In-browser projects",
      );
    });
  });

  it("searches across projects and opens the matched diagram", async () => {
    // A two-project tree so the search can match a diagram outside the
    // initially-selected project. Re-mock the picker to point at this tree.
    const work = new FakeDirectory("Work");
    work.children.set(
      "report.seq",
      new FakeFile(
        "report.seq",
        "title Report\nparticipant A\nparticipant B\nA -> B: report",
      ) as unknown as FsEntryHandle,
    );
    const customRoot = new FakeDirectory("Custom");
    customRoot.children.set(
      "Onboarding",
      buildFakeFolder().children.get("Onboarding") as unknown as FsEntryHandle,
    );
    customRoot.children.set("Work", work as unknown as FsEntryHandle);
    vi.spyOn(window, "showDirectoryPicker").mockResolvedValue(
      customRoot as unknown as FileSystemDirectoryHandle,
    );

    render(<App />);

    // The app does not auto-open a folder; clicking the button drives the
    // mocked picker at this tree.
    await act(async () => {
      fireEvent.click(screen.getByTestId("open-folder-button"));
    });

    // The FS repo replaces the default IDB repo. Wait for both projects to load.
    await waitFor(() => {
      expect(screen.getAllByTestId("explorer-project")).toHaveLength(2);
    });

    // The Onboarding project (first in the tree) loads first; its Welcome
    // diagram is not searchable by "report". The Work file is named
    // "report.seq", so the search matches on that name across projects.
    expect(screen.queryByLabelText("Load diagram report.seq")).toBeNull();

    // Searching "report" surfaces the Work project's diagram across projects.
    await act(async () => {
      fireEvent.change(screen.getByTestId("diagram-search-input"), {
        target: { value: "report" },
      });
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText("Load diagram report.seq"),
      ).toBeInTheDocument();
    });

    // Clicking the matched diagram opens it: the preview reflects "Report".
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Load diagram report.seq"));
    });
    await waitFor(() => {
      const svg = screen.getByTestId("preview-svg");
      expect(svg.textContent).toContain("Report");
    });
  });
});
