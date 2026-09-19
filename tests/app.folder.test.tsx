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

/** A file entry. `getFileHandle` throws when absent unless `createIfNotExists`. */
class FakeFile implements FsFileHandle {
  readonly kind = "file" as const;
  constructor(
    readonly name: string,
    public source: string,
  ) {}

  async getFile(): Promise<string> {
    return this.source;
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
      this.children.set(name, file);
      return file;
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
    new FakeFile("welcome.seq", "title Welcome\nA -> B: hi"),
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
});
