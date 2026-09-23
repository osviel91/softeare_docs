import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./app-harness";
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
    // This double plays the *native* `FileSystemDirectoryHandle`, whose option
    // for creating a missing file is `create`. The repository's own adapter
    // interface spells it `createIfNotExists`, and the bridge in
    // `create-file-system-repository.ts` translates between the two — so a double
    // that accepted the adapter's spelling would hide a broken translation.
    options?: { create?: boolean },
  ): Promise<FsFileHandle> {
    const existing = this.children.get(name);
    if (existing && existing.kind === "file") return existing;
    if (existing && existing.kind === "directory") {
      throw new Error(`entry exists as directory: ${name}`);
    }
    if (options?.create) {
      const file = new FakeFile(name, "");
      // FakeFile is a native handle (its `getFile()` yields a File-like object),
      // so it is cast here into the adapter contract the repository expects.
      this.children.set(name, file as unknown as FsEntryHandle);
      return file as unknown as FsFileHandle;
    }
    throw new Error(`no such file: ${name}`);
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FsDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing && existing.kind === "directory") return existing;
    if (existing && existing.kind === "file") {
      throw new Error(`entry exists as file: ${name}`);
    }
    if (!options?.create) throw new Error(`no such directory: ${name}`);
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
  // The hidden-path store is keyed by folder name (`sequencediagrams.hidden.<name>`)
  // and mirrored to `localStorage`, which jsdom shares across every test in a
  // file. Every test here opens the same "Test Folder" while rebuilding the fake
  // tree from scratch, so a path an earlier test hid — the delete-project test
  // hides a whole project — would hide the recreated one and leave this test
  // looking at an empty explorer. Wipe the slate first.
  try {
    localStorage.clear();
  } catch {
    // Node also exposes a global `localStorage` that throws unless it is started
    // with the experimental webstorage flags; there is nothing to clear there.
  }

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

async function openFolder(): Promise<void> {
  const toggle = screen.getByTestId("workspace-local-toggle");
  if (toggle.getAttribute("aria-expanded") === "false") {
    fireEvent.click(toggle);
  }
  const folderButton = await screen.findByTestId("workspace-open-folder");
  await act(async () => {
    fireEvent.click(folderButton);
  });
}

describe("App — local folder (Phase 5)", () => {
  it("opens a folder through the explorer and shows its name", async () => {
    render(<App />);

    fireEvent.click(screen.getByTestId("workspace-local-toggle"));
    const button = screen.getByTestId("workspace-open-folder");
    expect(button).toBeEnabled();

    await act(async () => {
      fireEvent.click(button);
    });

    // The folder name flows from the picker into the explorer header.
    await waitFor(() => {
      expect(screen.getByTestId("explorer-mode")).toHaveTextContent(
        "Local folder: Test Folder",
      );
    });

    // The real repository reads the fake tree, so the seeded project appears.
    await waitFor(() => {
      const projects = screen.getAllByTestId("explorer-project");
      expect(projects).toHaveLength(1);
      expect(projects[0]).toHaveTextContent("Onboarding");
    });
  });

  it("creates a project in an empty folder", async () => {
    const emptyRoot = new FakeDirectory("Empty Folder");
    vi.spyOn(window, "showDirectoryPicker").mockResolvedValue(
      emptyRoot as unknown as FileSystemDirectoryHandle,
    );
    render(<App />);

    await openFolder();
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "Docs" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));

    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent("Docs");
    });
    expect(emptyRoot.children.get("Docs")?.kind).toBe("directory");
    expect(screen.queryByTestId("workspace-error")).toBeNull();
  });

  it("renames a diagram from the title in its source, live", async () => {
    render(<App />);

    await openFolder();

    // The file on disk is `welcome.seq`; `title Welcome` names it everywhere.
    await waitFor(() => {
      expect(screen.getByLabelText("Load diagram Welcome")).toBeInTheDocument();
    });
    expect(screen.getByTestId("tab-label")).toHaveTextContent("Welcome");

    // Editing the title renames the diagram without a separate rename step.
    await act(async () => {
      fireEvent.change(screen.getByTestId("dsl-textarea"), {
        target: { value: "title Renamed\nA -> B: hi" },
      });
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Load diagram Renamed")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Load diagram Welcome")).toBeNull();
    expect(screen.getByTestId("tab-label")).toHaveTextContent("Renamed");

    // The file keeps its own name, so the title is free to differ from it.
    const project = fakeRoot.children.get(
      "Onboarding",
    ) as unknown as FakeDirectory;
    await waitFor(() => {
      const file = project.children.get("welcome.seq") as unknown as FakeFile;
      expect(file.source).toContain("title Renamed");
    });
  });

  it("closes the folder and returns to in-browser projects", async () => {
    render(<App />);

    await openFolder();
    await waitFor(() => {
      expect(screen.getByTestId("explorer-mode")).toHaveTextContent(
        "Local folder: Test Folder",
      );
    });

    // The local source now reads "Folder: Test Folder"; clicking it clears it.
    await act(async () => {
      fireEvent.click(screen.getByTestId("workspace-open-folder"));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("explorer-header")).toBeNull();
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
    await openFolder();

    // The FS repo replaces the default IDB repo. Wait for both projects to load.
    await waitFor(() => {
      expect(screen.getAllByTestId("explorer-project")).toHaveLength(2);
    });

    // The Onboarding project (first in the tree) loads first. The Work file is
    // named "report.seq" but titled "Report", so its own expanded project lists
    // it by title even though Onboarding is the selection.
    expect(screen.getByLabelText("Load diagram Report")).toBeInTheDocument();

    // Searching "report" keeps the Work project's diagram across projects.
    await act(async () => {
      fireEvent.change(screen.getByTestId("diagram-search-input"), {
        target: { value: "report" },
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Load diagram Report")).toBeInTheDocument();
    });

    // Clicking the matched diagram opens it: the preview reflects "Report".
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Load diagram Report"));
    });
    await waitFor(() => {
      const svg = screen.getByTestId("preview-svg");
      expect(svg.textContent).toContain("Report");
    });
  });
});

/** Open the local folder and wait until its diagram is listed. */
async function openFolderWithDiagram(): Promise<void> {
  render(<App />);
  await openFolder();
  await waitFor(() => {
    expect(screen.getByLabelText("Load diagram Welcome")).toBeInTheDocument();
  });
}

/** The Onboarding project directory inside the fake tree. */
function onboarding(): FakeDirectory {
  return fakeRoot.children.get("Onboarding") as unknown as FakeDirectory;
}

describe("App — safe delete in a folder", () => {
  it("confirms before removing a diagram", async () => {
    await openFolderWithDiagram();

    fireEvent.click(screen.getByTestId("diagram-menu-button"));
    fireEvent.click(screen.getByTestId("context-menu-delete"));
    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent(
      "Delete diagram",
    );

    // Cancelling leaves everything untouched.
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(screen.getByLabelText("Load diagram Welcome")).toBeInTheDocument();
    expect(onboarding().children.has("welcome.seq")).toBe(true);
  });

  it("removes a diagram from the app but keeps the file on disk", async () => {
    await openFolderWithDiagram();

    fireEvent.click(screen.getByTestId("diagram-menu-button"));
    fireEvent.click(screen.getByTestId("context-menu-delete"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-alternative"));
    });

    // Gone from the explorer...
    await waitFor(() => {
      expect(screen.queryByLabelText("Load diagram Welcome")).toBeNull();
    });
    // ...but still on disk, and recoverable from the explorer banner.
    expect(onboarding().children.has("welcome.seq")).toBe(true);
    expect(screen.getByTestId("explorer-hidden")).toHaveTextContent(
      "1 removed from app",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("unhide-all-button"));
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Load diagram Welcome")).toBeInTheDocument();
    });
  });

  it("deletes a diagram from disk when that scope is chosen", async () => {
    await openFolderWithDiagram();

    fireEvent.click(screen.getByTestId("diagram-menu-button"));
    fireEvent.click(screen.getByTestId("context-menu-delete"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    });

    await waitFor(() => {
      expect(screen.queryByLabelText("Load diagram Welcome")).toBeNull();
    });
    expect(onboarding().children.has("welcome.seq")).toBe(false);
    // A disk delete is permanent, so nothing is offered for restore.
    expect(screen.queryByTestId("explorer-hidden")).toBeNull();
  });

  it("removes a whole project from the app without deleting its directory", async () => {
    await openFolderWithDiagram();

    fireEvent.click(screen.getByTestId("project-menu-button"));
    fireEvent.click(screen.getByTestId("context-menu-delete-project"));
    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent(
      "Delete project",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-alternative"));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("explorer-project")).toBeNull();
    });
    expect(fakeRoot.children.has("Onboarding")).toBe(true);
  });
});

describe("App — diagram history", () => {
  it("records an initial version and captures checkpoints on demand", async () => {
    await openFolderWithDiagram();

    // The History view is a first-class editor view.
    fireEvent.click(screen.getByTestId("view-history"));
    await waitFor(() => {
      expect(screen.getByTestId("history-panel")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("history-version")).toHaveLength(1);
    });
    expect(screen.getByTestId("version-label")).toHaveTextContent(
      "Initial version",
    );

    // Edit the source, then capture it explicitly.
    fireEvent.click(screen.getByTestId("view-code"));
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "title Welcome v2\nA -> B: hi" },
    });
    fireEvent.click(screen.getByTestId("view-history"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-version-button"));
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("history-version")).toHaveLength(2);
    });
  });

  it("restores an older version into the editor", async () => {
    await openFolderWithDiagram();

    fireEvent.click(screen.getByTestId("view-code"));
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "title Welcome\nA -> B: changed" },
    });
    fireEvent.click(screen.getByTestId("view-history"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-version-button"));
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("history-version")).toHaveLength(2);
    });

    // Restore the older (initial) version: the editor buffer follows.
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("restore-version-button")[1]);
    });
    fireEvent.click(screen.getByTestId("view-code"));
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toHaveValue(
        "title Welcome\nA -> B: hi",
      );
    });
  });
});
