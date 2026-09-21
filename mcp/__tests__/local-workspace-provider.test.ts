/**
 * The provider seam: an application service must not know where its projects
 * live. These tests exercise `DocumentationWorkspace` through the port with a
 * provider whose backing store is **not** the local filesystem — the shape the
 * server provider will have — so the seam is proven before Phase 1 relies on it.
 */
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentationWorkspace } from "../workspace";
import { createLocalWorkspaceProvider } from "../../src/application/local-workspace-provider";
import { createNodeDirectoryHandle } from "../node-fs";
import type {
  ProjectWorkspace,
  ProjectWorkspaceProvider,
} from "../../src/application/ports";
import type { Project } from "../../src/domain/workspace/types";
import { createInMemoryWorkspaceRepository } from "../../src/workspace/in-memory";

/** A project workspace backed by the in-memory repository, not a directory. */
function inMemoryProvider(): ProjectWorkspaceProvider {
  const repo = createInMemoryWorkspaceRepository();
  const projects = new Map<string, Project>();

  return {
    describe: () => "in-memory",

    async listProjects() {
      return [...projects.values()];
    },

    async openProject(project): Promise<ProjectWorkspace | null> {
      if (!projects.has(project.id)) return null;
      return { project, repo, root: `/memory/${project.id}` };
    },

    async createProject(name) {
      const result = await repo.createProject(name);
      if (!result.ok) throw result.error;
      projects.set(result.value.id, result.value);
      return result.value;
    },
  };
}

describe("DocumentationWorkspace.over", () => {
  it("serves a non-filesystem provider through the same service", async () => {
    const workspace = DocumentationWorkspace.over(inMemoryProvider());
    const created = await workspace.createProject("Payments");
    expect(created.name).toBe("Payments");

    expect(created.id).not.toBe("");
    const listed = await workspace.listProjects();
    expect(listed.map((entry) => entry.name)).toEqual(["Payments"]);
  });

  it("refuses to invent a second project with an existing name", async () => {
    const workspace = DocumentationWorkspace.over(inMemoryProvider());
    await workspace.createProject("Payments");
    await expect(workspace.createProject("Payments")).rejects.toThrow(
      /already exists/,
    );
  });

  it("reports the provider's description rather than a path it computed", () => {
    const workspace = DocumentationWorkspace.over(inMemoryProvider());
    expect(workspace.describe).toBe("in-memory");
  });

  it("writes, reads and validates a resource through the shared service", async () => {
    const workspace = DocumentationWorkspace.over(inMemoryProvider());
    await workspace.createProject("Payments");
    await workspace.createProject("Other");
    const project = await workspace.resolveProject("Payments");

    const created = await workspace.createResource(project, {
      kind: "diagram",
      name: "checkout",
      content: "participant A\nA -> B: hi\n",
    });
    expect(created.resource.path).toBe("checkout.seq");

    const read = await workspace.readResource(project, "checkout.seq");
    expect(read.content).toContain("A -> B: hi");
  });

  it("names the project a tool must supply when several exist", async () => {
    const workspace = DocumentationWorkspace.over(inMemoryProvider());
    await workspace.createProject("One");
    await workspace.createProject("Two");
    await expect(workspace.resolveProject()).rejects.toThrow(
      /project" is required/,
    );
  });
});

describe("createLocalWorkspaceProvider", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function workspaceRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "sd-provider-"));
    roots.push(root);
    return root;
  }

  it("describes itself with the resolved directory", async () => {
    const root = await workspaceRoot();
    const provider = createLocalWorkspaceProvider(
      root,
      createNodeDirectoryHandle,
    );
    expect(provider.describe()).toBe(path.resolve(root));
  });

  it("lists subdirectories as projects", async () => {
    const root = await workspaceRoot();
    await mkdir(path.join(root, "Payments"));
    const provider = createLocalWorkspaceProvider(
      root,
      createNodeDirectoryHandle,
    );
    const projects = await provider.listProjects();
    expect(projects.map((project) => project.name)).toContain("Payments");
  });

  it("opens a project inside the root", async () => {
    const root = await workspaceRoot();
    await mkdir(path.join(root, "Payments"));
    const provider = createLocalWorkspaceProvider(
      root,
      createNodeDirectoryHandle,
    );
    const [project] = await provider.listProjects();
    const workspace = await provider.openProject(project);
    expect(workspace?.root).toBe(path.join(path.resolve(root), project.id));
  });

  it("refuses a project id that escapes the root", async () => {
    const root = await workspaceRoot();
    await mkdir(path.join(root, "Payments"));
    const provider = createLocalWorkspaceProvider(
      root,
      createNodeDirectoryHandle,
    );
    const outside = await provider.openProject({
      id: "../elsewhere",
      name: "elsewhere",
      datasetIds: [],
    });
    expect(outside).toBeNull();
  });

  it("creates a project directory on request", async () => {
    const root = await workspaceRoot();
    const provider = createLocalWorkspaceProvider(
      root,
      createNodeDirectoryHandle,
    );
    const project = await provider.createProject("Ledger");
    expect(project?.name).toBe("Ledger");
    expect(await readdir(path.resolve(root))).toContain(project?.id ?? "");
  });

  it("keeps the app's `project.json` identity record out of the file listing", async () => {
    const root = await workspaceRoot();
    const provider = createLocalWorkspaceProvider(
      root,
      createNodeDirectoryHandle,
    );
    const project = await provider.createProject("Ledger");
    const workspace = await provider.openProject(project as Project);
    await writeFile(
      path.join(workspace?.root ?? "", "note.md"),
      "# Note\n",
      "utf8",
    );
    const notes = await workspace?.repo.listNoteFiles((project as Project).id);
    expect(notes?.ok && notes.value.map((note) => note.name)).toEqual([
      "note.md",
    ]);
  });
});
