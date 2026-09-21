import { describe, expect, it } from "vitest";
import {
  PROJECT_METADATA_FORMAT,
  PROJECT_METADATA_VERSION,
  createEmptyMetadata,
  type ProjectMetadata,
} from "../../src/domain/workspace/metadata";
import type { DiagramFile } from "../../src/domain/workspace/types";
import { isOk } from "../../src/shared/result/result";
import type {
  FsDirectoryHandle,
  FsEntryHandle,
  FsFileHandle,
  FsWritable,
} from "../../src/workspace/fs-access/fs-access-adapter";
import { createFileSystemWorkspaceRepository } from "../../src/workspace/fs-access/file-system-workspace-repository";
import type { WorkspaceRepository } from "../../src/workspace/WorkspaceRepository";

/** A writable that overwrites its file's source, mirroring the real API. */
class FakeWritable implements FsWritable {
  constructor(private file: FakeFile) {}

  async write(chunk: Uint8Array): Promise<void> {
    this.file.source = new TextDecoder().decode(chunk);
  }

  async close(): Promise<void> {
    /* nothing to flush in memory */
  }
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

/** A directory entry. Lazily creates subdirectories, like the real API. */
class FakeDirectory implements FsDirectoryHandle {
  readonly kind = "directory" as const;
  public children = new Map<string, FsEntryHandle>();

  constructor(readonly name: string) {}

  async entries(): Promise<Array<[string, FsEntryHandle]>> {
    // The repository awaits `entries()` then iterates synchronously, so a resolved
    // array models the real async-iterable well enough here. (The app-level test
    // exercises the adapter's `for await` path, which needs an async generator.)
    return [...this.children.entries()];
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
    this.children.set(name, dir);
    return dir;
  }

  async removeEntry(name: string): Promise<void> {
    this.children.delete(name);
  }
}

/** Build a root directory with the given project/directory tree pre-seeded. */
function buildTree(
  rootName: string,
  seedEntries: Record<string, string> = {},
): FakeDirectory {
  const root = new FakeDirectory(rootName);
  for (const [relativePath, source] of Object.entries(seedEntries)) {
    const segments = relativePath.split("/");
    const name = segments.pop() as string;
    let dir: FakeDirectory = root;
    for (const segment of segments) {
      const existing = dir.children.get(segment);
      if (!existing || existing.kind !== "directory") {
        const child = new FakeDirectory(segment);
        dir.children.set(segment, child);
      }
      dir = dir.children.get(segment) as FakeDirectory;
    }
    dir.children.set(name, new FakeFile(name, source));
  }
  return root;
}

describe("File System workspace repository", () => {
  let repo: WorkspaceRepository;
  let root: FakeDirectory;

  beforeEach(() => {
    root = buildTree("Workspace", {
      "onboarding/welcome.seq": "title Welcome\nA -> B: hi",
      "onboarding/signup.seq": "title Signup\nA -> B: join",
      "team/backend/architecture.seq": "title Arch\nA -> B: design",
    });
    repo = createFileSystemWorkspaceRepository(
      root as unknown as FsDirectoryHandle,
    );
  });

  it("starts with the seeded projects in display order", async () => {
    const result = await repo.listProjects();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const ids = result.value.map((p) => p.id);
      // Every subdirectory is a project; deepest paths sort last so nested
      // folders follow their parents.
      expect(ids).toEqual(["team/backend", "onboarding", "team"]);
    }
  });

  it("lists a project's diagrams with their source", async () => {
    const result = await repo.listDiagramFiles("onboarding");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const names = result.value.map((d) => d.name);
      expect(names).toEqual(["welcome.seq", "signup.seq"]);
      const welcome = result.value.find((d) => d.name === "welcome.seq");
      expect(welcome?.source).toBe("title Welcome\nA -> B: hi");
      expect(welcome?.projectId).toBe("onboarding");
    }
  });

  it("returns an empty list for a project with no directory yet", async () => {
    const result = await repo.listDiagramFiles("does-not-exist");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual([]);
    }
  });

  it("loads a single diagram by its root-relative path", async () => {
    const result = await repo.getDiagramFile(
      "team/backend",
      "team/backend/architecture.seq",
    );
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).not.toBeNull();
      expect(result.value?.name).toBe("architecture.seq");
      expect(result.value?.source).toBe("title Arch\nA -> B: design");
    }
  });

  it("returns null for a diagram outside the requested project", async () => {
    const result = await repo.getDiagramFile(
      "onboarding",
      "team/backend/architecture.seq",
    );
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBeNull();
    }
  });

  it("creates a new diagram file and reads it back", async () => {
    const diagram: DiagramFile = {
      id: "onboarding/new.seq",
      name: "new.seq",
      source: "title New\nA -> B: fresh",
      projectId: "onboarding",
    };
    const saved = await repo.saveDiagramFile("onboarding", diagram);
    expect(isOk(saved)).toBe(true);
    if (isOk(saved)) {
      expect(saved.value.id).toBe("onboarding/new.seq");
    }

    const loaded = await repo.getDiagramFile(
      "onboarding",
      "onboarding/new.seq",
    );
    if (isOk(loaded)) {
      expect(loaded.value?.source).toBe("title New\nA -> B: fresh");
    }
  });

  it("writes into a nested project directory, creating parents", async () => {
    const diagram: DiagramFile = {
      id: "team/backend/notes.seq",
      name: "notes.seq",
      source: "title Notes\nA -> B: memo",
      projectId: "team/backend",
    };
    const saved = await repo.saveDiagramFile("team/backend", diagram);
    expect(isOk(saved)).toBe(true);

    const listed = await repo.listDiagramFiles("team/backend");
    if (isOk(listed)) {
      expect(listed.value.map((d) => d.name)).toContain("notes.seq");
    }
  });

  it("overwrites an existing diagram file", async () => {
    const first: DiagramFile = {
      id: "onboarding/welcome.seq",
      name: "welcome.seq",
      source: "v1",
      projectId: "onboarding",
    };
    const second: DiagramFile = {
      id: "onboarding/welcome.seq",
      name: "welcome.seq",
      source: "v2 changed",
      projectId: "onboarding",
    };

    await repo.saveDiagramFile("onboarding", first);
    const saved = await repo.saveDiagramFile("onboarding", second);
    if (isOk(saved)) {
      expect(saved.value.source).toBe("v2 changed");
    }

    const loaded = await repo.getDiagramFile(
      "onboarding",
      "onboarding/welcome.seq",
    );
    if (isOk(loaded)) {
      expect(loaded.value?.source).toBe("v2 changed");
    }
  });

  it("deletes a diagram file from a project", async () => {
    await repo.saveDiagramFile("onboarding", {
      id: "onboarding/temp.seq",
      name: "temp.seq",
      source: "x",
      projectId: "onboarding",
    });

    const deleted = await repo.deleteDiagramFile(
      "onboarding",
      "onboarding/temp.seq",
    );
    expect(isOk(deleted)).toBe(true);

    const listed = await repo.listDiagramFiles("onboarding");
    if (isOk(listed)) {
      expect(listed.value.map((d) => d.name)).not.toContain("temp.seq");
    }
  });

  it("creates an empty project directory", async () => {
    const created = await repo.createProject("team/frontend");
    expect(isOk(created)).toBe(true);
    if (isOk(created)) {
      expect(created.value.id).toBe("team/frontend");
      expect(created.value.name).toBe("frontend");
    }

    const listed = await repo.listProjects();
    if (isOk(listed)) {
      expect(listed.value.map((p) => p.id)).toContain("team/frontend");
    }
  });

  it("renames a project by moving its directory, files and all", async () => {
    const renamed = await repo.renameProject("onboarding", "Getting started");
    expect(isOk(renamed)).toBe(true);
    if (!isOk(renamed)) return;
    // The path is the id, so the new project gets a new id.
    expect(renamed.value).toMatchObject({
      id: "Getting started",
      name: "Getting started",
    });

    expect(root.children.has("onboarding")).toBe(false);
    const moved = root.children.get(
      "Getting started",
    ) as unknown as FakeDirectory;
    expect(moved.children.has("welcome.seq")).toBe(true);
    expect(moved.children.has("signup.seq")).toBe(true);
    // The file contents travelled with the directory.
    const files = await repo.listDiagramFiles("Getting started");
    if (isOk(files)) {
      expect(files.value.map((file) => file.name).sort()).toEqual([
        "signup.seq",
        "welcome.seq",
      ]);
    }
  });

  it("refuses to rename a project onto an existing sibling", async () => {
    const result = await repo.renameProject("onboarding", "team");
    expect(isOk(result)).toBe(false);
    // Both directories are untouched.
    expect(root.children.has("onboarding")).toBe(true);
    expect(root.children.has("team")).toBe(true);
  });

  it("treats renaming a project to the same name as a no-op", async () => {
    const result = await repo.renameProject("onboarding", "onboarding");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.id).toBe("onboarding");
    }
    expect(root.children.has("onboarding")).toBe(true);
  });

  it("refuses an empty project name and a name with a path separator", async () => {
    expect(isOk(await repo.renameProject("onboarding", "   "))).toBe(false);
    expect(isOk(await repo.renameProject("onboarding", "a/b"))).toBe(false);
    expect(root.children.has("onboarding")).toBe(true);
  });

  it("deletes a project directory and its files", async () => {
    await repo.saveDiagramFile("onboarding", {
      id: "onboarding/gone.seq",
      name: "gone.seq",
      source: "x",
      projectId: "onboarding",
    });

    const deleted = await repo.deleteProject("onboarding");
    expect(isOk(deleted)).toBe(true);

    const remaining = await repo.listProjects();
    if (isOk(remaining)) {
      expect(remaining.value.map((p) => p.id)).not.toContain("onboarding");
    }

    const files = await repo.listDiagramFiles("onboarding");
    if (isOk(files)) {
      expect(files.value).toEqual([]);
    }
  });

  it("creates an empty diagram file named Untitled in a project", async () => {
    const result = await repo.createEmptyDiagram("onboarding");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.name).toBe("Untitled");
      expect(result.value.source).toBe("");
      expect(result.value.id).toBe("onboarding/Untitled");
    }

    // The file is materialized on disk and readable back.
    const loaded = await repo.getDiagramFile(
      "onboarding",
      "onboarding/Untitled",
    );
    if (isOk(loaded)) {
      expect(loaded.value?.source).toBe("");
    }

    const listed = await repo.listDiagramFiles("onboarding");
    if (isOk(listed)) {
      expect(listed.value.map((d) => d.name)).toContain("Untitled");
    }
  });

  it("creates uniquely named empty diagrams", async () => {
    const first = await repo.createEmptyDiagram("onboarding");
    const second = await repo.createEmptyDiagram("onboarding");
    if (!isOk(first) || !isOk(second)) throw new Error("create failed");
    expect(first.value.name).toBe("Untitled");
    expect(second.value.name).toBe("Untitled 2");
    expect(second.value.id).toBe("onboarding/Untitled 2");
  });

  it("duplicates a diagram under a free copy name, keeping its source", async () => {
    const copy = await repo.duplicateDiagramFile(
      "onboarding",
      "onboarding/welcome.seq",
    );
    if (!isOk(copy)) throw copy.error;
    expect(copy.value.name).toBe("welcome copy.seq");
    expect(copy.value.id).toBe("onboarding/welcome copy.seq");
    expect(copy.value.source).toContain("title Welcome");

    // The original is untouched and the copy exists on disk.
    const dir = root.children.get("onboarding") as unknown as FakeDirectory;
    expect(dir.children.has("welcome.seq")).toBe(true);
    expect(dir.children.has("welcome copy.seq")).toBe(true);

    const again = await repo.duplicateDiagramFile(
      "onboarding",
      "onboarding/welcome.seq",
    );
    if (!isOk(again)) throw again.error;
    expect(again.value.name).toBe("welcome copy 2.seq");
  });

  it("captures the whole workspace as a snapshot", async () => {
    const snapshot = await repo.listAll();
    expect(isOk(snapshot)).toBe(true);
    if (isOk(snapshot)) {
      // Every seeded file appears exactly once across all projects.
      const names = snapshot.value.diagrams.map((d) => d.id);
      expect(names).toContain("onboarding/welcome.seq");
      expect(names).toContain("team/backend/architecture.seq");
    }
  });

  it("surfaces repository errors as a failed Result, not a throw", async () => {
    // A root that cannot be enumerated (empty path) must not throw.
    const result = await repo.getDiagramFile("", "");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBeNull();
    }
  });
});

describe("File System workspace repository — notes", () => {
  let repo: WorkspaceRepository;
  let root: FakeDirectory;

  beforeEach(() => {
    root = buildTree("Workspace", {
      "onboarding/welcome.seq": "title Welcome\nA -> B: hi",
      "onboarding/readme.md": "# Onboarding\n\nStart with [[Welcome]].",
    });
    repo = createFileSystemWorkspaceRepository(
      root as unknown as FsDirectoryHandle,
    );
  });

  /** The Onboarding directory inside the fake tree. */
  function onboarding(): FakeDirectory {
    return root.children.get("onboarding") as unknown as FakeDirectory;
  }

  it("treats markdown files as notes, not diagrams", async () => {
    const diagrams = await repo.listDiagramFiles("onboarding");
    if (!isOk(diagrams)) throw diagrams.error;
    expect(diagrams.value.map((entry) => entry.name)).toEqual(["welcome.seq"]);

    const notes = await repo.listNoteFiles("onboarding");
    if (!isOk(notes)) throw notes.error;
    expect(notes.value.map((entry) => entry.name)).toEqual(["readme.md"]);
    expect(notes.value[0].markdown).toContain("[[Welcome]]");
    expect(notes.value[0].id).toBe("onboarding/readme.md");
  });

  it("reads one note by its path", async () => {
    const note = await repo.getNoteFile("onboarding", "onboarding/readme.md");
    if (!isOk(note)) throw note.error;
    expect(note.value?.markdown).toContain("# Onboarding");
  });

  it("does not return a note that lives outside the project", async () => {
    const note = await repo.getNoteFile("team", "onboarding/readme.md");
    if (!isOk(note)) throw note.error;
    expect(note.value).toBeNull();
  });

  it("writes a note and appends the markdown extension when missing", async () => {
    const saved = await repo.saveNoteFile("onboarding", {
      id: "",
      name: "design",
      markdown: "# Design\n",
      projectId: "onboarding",
    });
    if (!isOk(saved)) throw saved.error;
    expect(saved.value.name).toBe("design.md");
    expect(saved.value.id).toBe("onboarding/design.md");
    expect(onboarding().children.has("design.md")).toBe(true);

    const reloaded = await repo.getNoteFile(
      "onboarding",
      "onboarding/design.md",
    );
    if (!isOk(reloaded)) throw reloaded.error;
    expect(reloaded.value?.markdown).toBe("# Design\n");
  });

  it("creates uniquely named empty notes", async () => {
    const first = await repo.createEmptyNote("onboarding");
    const second = await repo.createEmptyNote("onboarding");
    if (!isOk(first) || !isOk(second)) throw new Error("create failed");
    expect(first.value.name).toBe("Untitled.md");
    expect(second.value.name).toBe("Untitled 2.md");
    expect(second.value.markdown).toBe("# Untitled\n");
  });

  it("duplicates a note under a free copy name, keeping its markdown", async () => {
    const copy = await repo.duplicateNoteFile(
      "onboarding",
      "onboarding/readme.md",
    );
    if (!isOk(copy)) throw copy.error;
    expect(copy.value.name).toBe("readme copy.md");
    expect(copy.value.id).toBe("onboarding/readme copy.md");
    expect(copy.value.markdown).toContain("# Onboarding");
    expect(onboarding().children.has("readme copy.md")).toBe(true);

    const again = await repo.duplicateNoteFile(
      "onboarding",
      "onboarding/readme.md",
    );
    if (!isOk(again)) throw again.error;
    expect(again.value.name).toBe("readme copy 2.md");
    expect(again.value.markdown).toContain("[[Welcome]]");
  });

  it("deletes a note file", async () => {
    const deleted = await repo.deleteNoteFile(
      "onboarding",
      "onboarding/readme.md",
    );
    expect(isOk(deleted)).toBe(true);
    expect(onboarding().children.has("readme.md")).toBe(false);
  });

  it("renames a note by moving its content to the new path", async () => {
    const renamed = await repo.renameNoteFile(
      "onboarding",
      "onboarding/readme.md",
      "guide",
    );
    if (!isOk(renamed)) throw renamed.error;
    // The path *is* the id on disk, so the id changes with the name.
    expect(renamed.value.id).toBe("onboarding/guide.md");
    expect(renamed.value.name).toBe("guide.md");
    expect(onboarding().children.has("readme.md")).toBe(false);
    expect(onboarding().children.has("guide.md")).toBe(true);

    const reloaded = await repo.getNoteFile(
      "onboarding",
      "onboarding/guide.md",
    );
    if (!isOk(reloaded)) throw reloaded.error;
    expect(reloaded.value?.markdown).toContain("[[Welcome]]");
  });

  it("refuses a note rename onto an existing file", async () => {
    await repo.saveNoteFile("onboarding", {
      id: "",
      name: "guide.md",
      markdown: "# Guide\n",
      projectId: "onboarding",
    });

    const renamed = await repo.renameNoteFile(
      "onboarding",
      "onboarding/readme.md",
      "guide",
    );
    expect(isOk(renamed)).toBe(false);
    // The original survives a refused rename.
    expect(onboarding().children.has("readme.md")).toBe(true);
  });

  it("renames a diagram by moving its content to the new path", async () => {
    const renamed = await repo.renameDiagramFile(
      "onboarding",
      "onboarding/welcome.seq",
      "start.seq",
    );
    if (!isOk(renamed)) throw renamed.error;
    expect(renamed.value.id).toBe("onboarding/start.seq");
    expect(onboarding().children.has("welcome.seq")).toBe(false);

    const reloaded = await repo.getDiagramFile(
      "onboarding",
      "onboarding/start.seq",
    );
    if (!isOk(reloaded)) throw reloaded.error;
    expect(reloaded.value?.source).toBe("title Welcome\nA -> B: hi");
  });

  it("refuses a diagram rename onto an existing file", async () => {
    const renamed = await repo.renameDiagramFile(
      "onboarding",
      "onboarding/welcome.seq",
      "readme.md",
    );
    expect(isOk(renamed)).toBe(false);
  });

  it("renaming a diagram to the same name is a no-op", async () => {
    const renamed = await repo.renameDiagramFile(
      "onboarding",
      "onboarding/welcome.seq",
      "welcome.seq",
    );
    if (!isOk(renamed)) throw renamed.error;
    expect(renamed.value.id).toBe("onboarding/welcome.seq");
  });

  it("includes notes in the workspace snapshot", async () => {
    const snapshot = await repo.listAll();
    if (!isOk(snapshot)) throw snapshot.error;
    expect(snapshot.value.notes?.map((entry) => entry.id)).toEqual([
      "onboarding/readme.md",
    ]);
  });
});

describe("File System workspace repository — project metadata", () => {
  let repo: WorkspaceRepository;
  let root: FakeDirectory;

  beforeEach(() => {
    root = buildTree("Workspace", {
      "onboarding/welcome.seq": "title Welcome\nA -> B: hi",
    });
    repo = createFileSystemWorkspaceRepository(
      root as unknown as FsDirectoryHandle,
    );
  });

  /** The Onboarding directory inside the fake tree. */
  function onboarding(): FakeDirectory {
    return root.children.get("onboarding") as unknown as FakeDirectory;
  }

  /** A minimal, well-formed metadata document with one recorded diagram. */
  function sampleMetadata(): ProjectMetadata {
    return {
      format: PROJECT_METADATA_FORMAT,
      version: PROJECT_METADATA_VERSION,
      resources: [
        {
          id: "diagram-welcome",
          path: "welcome.seq",
          type: "sequence-diagram",
          title: "Welcome",
        },
      ],
    };
  }

  it("round-trips metadata through project.json", async () => {
    const metadata = sampleMetadata();
    const written = await repo.writeProjectMetadata("onboarding", metadata);
    expect(isOk(written)).toBe(true);

    // The sidecar is materialized on disk beside the project's files.
    expect(onboarding().children.has("project.json")).toBe(true);

    const read = await repo.readProjectMetadata("onboarding");
    expect(isOk(read)).toBe(true);
    if (isOk(read)) {
      expect(read.value).toEqual(metadata);
    }
  });

  it("creates a missing project directory when writing metadata", async () => {
    const written = await repo.writeProjectMetadata(
      "fresh",
      createEmptyMetadata(),
    );
    expect(isOk(written)).toBe(true);

    const listed = await repo.listProjects();
    if (isOk(listed)) {
      expect(listed.value.map((project) => project.id)).toContain("fresh");
    }
  });

  it("reads null when a project has no metadata file", async () => {
    const read = await repo.readProjectMetadata("onboarding");
    expect(isOk(read)).toBe(true);
    if (isOk(read)) {
      expect(read.value).toBeNull();
    }
  });

  it("reads null when the project directory is absent", async () => {
    const read = await repo.readProjectMetadata("does-not-exist");
    expect(isOk(read)).toBe(true);
    if (isOk(read)) {
      expect(read.value).toBeNull();
    }
  });

  it("reads null for a metadata file that is not valid JSON", async () => {
    onboarding().children.set(
      "project.json",
      new FakeFile("project.json", "{ this is not json"),
    );

    const read = await repo.readProjectMetadata("onboarding");
    expect(isOk(read)).toBe(true);
    if (isOk(read)) {
      expect(read.value).toBeNull();
    }
  });

  it("reads null for JSON that is not a project metadata document", async () => {
    onboarding().children.set(
      "project.json",
      new FakeFile(
        "project.json",
        JSON.stringify({ format: "something-else" }),
      ),
    );

    const read = await repo.readProjectMetadata("onboarding");
    expect(isOk(read)).toBe(true);
    if (isOk(read)) {
      expect(read.value).toBeNull();
    }
  });

  it("never lists project.json as a diagram, but lists a real diagram beside it", async () => {
    await repo.writeProjectMetadata("onboarding", sampleMetadata());

    const listed = await repo.listDiagramFiles("onboarding");
    if (!isOk(listed)) throw listed.error;
    const names = listed.value.map((entry) => entry.name);
    expect(names).not.toContain("project.json");
    expect(names).toContain("welcome.seq");
  });
});
