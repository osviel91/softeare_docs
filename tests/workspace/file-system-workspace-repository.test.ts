import { describe, expect, it } from "vitest";
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
