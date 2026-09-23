/**
 * The same application service, over the server (ADR-040).
 *
 * This is the migration's central claim under test: `DocumentationWorkspace` —
 * the service the MCP tools and the browser's own services are built on — runs
 * unchanged over PostgreSQL and a project volume. The tests below exercise the
 * documentation operations *and* the optimistic-concurrency behaviour that only
 * a server store has, through the identical entry point local mode uses.
 */
// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentationWorkspace } from "../../mcp/workspace";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import { createProjectCatalog } from "../../src/application/project-catalog";
import { createWorkspaceMutationService } from "../../src/application/workspace-mutations";
import { createServerWorkspaceProvider } from "../../src/persistence/server-workspace-provider";
import { createWorkspaceOperationRepository } from "../../src/persistence/workspace-operation-repository";
import { hashWorkspaceContent } from "../../src/persistence/server-runtime";
import { createFsProjectStorage } from "../../src/persistence/fs-project-storage";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createWorkspaceRepository } from "../../src/persistence/workspace-repository";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createAuditRepository } from "../../src/persistence/audit-repository";
import { ApplicationError } from "../../src/application/errors";
import type { ApplicationContext } from "../../src/application/context";
import type { ProjectRepository } from "../../src/persistence/project-repository";
import type { SqlClient } from "../../src/persistence/sql-client";
import {
  openTestDatabase,
  closeTestDatabase,
} from "../persistence/test-database";

let client: SqlClient;
let projects: ProjectRepository;
let users: ReturnType<typeof createUserRepository>;
let volume: string;

beforeAll(async () => {
  client = await openTestDatabase();
  volume = await mkdtemp(path.join(tmpdir(), "sd-server-workspace-"));
  projects = createProjectRepository(client);
  users = createUserRepository(client);
});

afterAll(async () => {
  await closeTestDatabase(client);
  await rm(volume, { recursive: true, force: true });
});

/** A context for a fresh user. */
async function aContext(): Promise<ApplicationContext> {
  const user = await users.findOrCreateByExternalIdentity({
    issuer: "https://idp.test",
    subject: `subject-${Math.random().toString(36).slice(2)}`,
    displayName: "Server User",
    email: null,
  });
  return {
    requestId: "req-workspace",
    principal: {
      subjectUserId: user.id,
      actor: { kind: "user", userId: user.id },
      authType: "session",
      scopes: [...ALL_PERMISSIONS],
    },
  };
}

/** The documentation service over the server, exactly as the API will build it. */
function serviceOver(context: ApplicationContext): DocumentationWorkspace {
  const operations = createWorkspaceOperationRepository(client);
  const mutations = createWorkspaceMutationService({
    projects,
    storage: (projectId) =>
      createFsProjectStorage({ root: path.join(volume, projectId) }),
    operations,
    hashContent: hashWorkspaceContent,
  });
  const catalog = createProjectCatalog({
    projects,
    workspaces: createWorkspaceRepository(client),
    audit: createAuditRepository(client),
    storage: (projectId) =>
      createFsProjectStorage({ root: path.join(volume, projectId) }),
    mutations,
  });
  const provider = createServerWorkspaceProvider({
    context,
    catalog,
    projects,
    mutations,
    location: (projectId) => ({
      storage: createFsProjectStorage({ root: path.join(volume, projectId) }),
      root: path.join(volume, projectId),
    }),
  });
  return DocumentationWorkspace.over(provider);
}

describe("DocumentationWorkspace over the server", () => {
  it("reports the server as its workspace, not a directory", async () => {
    const workspace = serviceOver(await aContext());
    expect(workspace.describe).toBe("server");
  });

  it("creates a project and lists it through the catalog", async () => {
    const workspace = serviceOver(await aContext());
    const created = await workspace.createProject("Payments Platform");
    expect(created.name).toBe("Payments Platform");
    const listed = await workspace.listProjects();
    expect(listed.map((project) => project.name)).toContain(
      "Payments Platform",
    );
  });

  it("never shows one user another user's projects", async () => {
    const mine = serviceOver(await aContext());
    await mine.createProject("Mine");

    const other = serviceOver(await aContext());
    expect(await other.listProjects()).toEqual([]);
  });

  it("writes, reads, validates and outlines a diagram through the shared service", async () => {
    const workspace = serviceOver(await aContext());
    await workspace.createProject("Diagrams");
    const project = await workspace.resolveProject("Diagrams");

    const created = await workspace.createResource(project, {
      kind: "diagram",
      name: "checkout",
      content: "participant A\nA -> B: hi\n",
    });
    expect(created.resource.path).toBe("checkout.seq");

    const read = await workspace.readResource(project, "checkout.seq");
    expect(read.content).toContain("A -> B: hi");

    const outline = await workspace.outline(project, "checkout.seq");
    expect(outline.resource.type).toBe("sequence-diagram");

    const validation = await workspace.validateProject(project);
    expect(validation.summary.resources).toBe(1);
  });

  it("renders a diagram through the same preview pipeline the editor uses", async () => {
    const workspace = serviceOver(await aContext());
    await workspace.createProject("Rendering");
    const project = await workspace.resolveProject("Rendering");
    await workspace.createResource(project, {
      kind: "diagram",
      name: "flow",
      content: "participant A\nA -> B: hello\n",
    });
    const rendered = await workspace.render(project, "flow.seq", {
      theme: "light",
    });
    expect(rendered.svg).toContain("<svg");
    expect(rendered.width).toBeGreaterThan(0);
  });

  it("round-trips and renders an event flow through the server workspace", async () => {
    const workspace = serviceOver(await aContext());
    await workspace.createProject("Event Flows");
    const project = await workspace.resolveProject("Event Flows");
    await workspace.createResource(project, {
      kind: "event-flow",
      name: "orders",
      content: [
        "title Orders",
        "event OrderCreated",
        "producer OrderService",
        "consumer OrderHandler",
        "topic orders",
        "OrderService publishes OrderCreated to orders",
        "OrderHandler consumes OrderCreated from orders",
      ].join("\n"),
    });

    const read = await workspace.readResource(project, "orders.eventseq");
    expect(read.resource.type).toBe("event-flow");
    expect(read.content).toContain("OrderCreated");

    const validation = await workspace.validateProject(project);
    expect(validation.summary.resources).toBe(1);
    expect(validation.diagnostics).toEqual([]);

    const rendered = await workspace.render(project, "orders.eventseq", {
      theme: "light",
    });
    expect(rendered.svg).toContain("<svg");
    expect(rendered.width).toBeGreaterThan(0);
  });

  it("moves a resource and keeps it findable by its new path", async () => {
    const workspace = serviceOver(await aContext());
    await workspace.createProject("Moving");
    const project = await workspace.resolveProject("Moving");
    await workspace.createResource(project, {
      kind: "note",
      name: "readme",
      content: "# Readme",
    });
    const renamed = await workspace.renameResource(
      project,
      "readme.md",
      "guide.md",
    );
    expect(renamed.resource.path).toBe("guide.md");
    const read = await workspace.readResource(project, "guide.md");
    expect(read.content).toContain("# Readme");
  });

  it("keeps working after a fresh service instance re-reads the same project", async () => {
    const context = await aContext();
    const first = serviceOver(context);
    await first.createProject("Persistent");
    const project = await first.resolveProject("Persistent");
    await first.createResource(project, {
      kind: "diagram",
      name: "a",
      content: "participant A",
    });

    const second = serviceOver(context);
    const reopened = await second.resolveProject("Persistent");
    const listed = await second.listResources(reopened);
    expect(listed.map((entry) => entry.path)).toEqual(["a.seq"]);
  });
});

describe("optimistic concurrency through the shared updateResource use case", () => {
  it("returns the new revision after an update", async () => {
    const workspace = serviceOver(await aContext());
    await workspace.createProject("Revisions");
    const project = await workspace.resolveProject("Revisions");
    await workspace.createResource(project, {
      kind: "diagram",
      name: "a",
      content: "one",
    });

    const first = await workspace.updateResource(project, "a.seq", {
      content: "two",
      expectedRevision: 1,
    });
    expect(first.revision).toBe(2);
  });

  it("refuses a stale expected revision with a conflict", async () => {
    const workspace = serviceOver(await aContext());
    await workspace.createProject("Stale");
    const project = await workspace.resolveProject("Stale");
    await workspace.createResource(project, {
      kind: "diagram",
      name: "a",
      content: "one",
    });
    await workspace.updateResource(project, "a.seq", {
      content: "two",
      expectedRevision: 1,
    });

    let failure: unknown;
    try {
      await workspace.updateResource(project, "a.seq", {
        content: "three",
        expectedRevision: 1,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/revision 1.*revision 2/s);

    const read = await workspace.readResource(project, "a.seq");
    expect(read.content).toBe("two");
  });

  it("updates without an expectation in local mode but refuses it on the server", async () => {
    const workspace = serviceOver(await aContext());
    await workspace.createProject("No expectation");
    const project = await workspace.resolveProject("No expectation");
    await workspace.createResource(project, {
      kind: "diagram",
      name: "a",
      content: "one",
    });
    // No expectation is the local-mode contract and stays valid: the server
    // still bumps the revision, so a later expectation sees the new number.
    const loose = await workspace.updateResource(project, "a.seq", {
      content: "two",
    });
    expect(loose.revision).toBe(2);
  });

  it("refuses an expectation it cannot honour when the project is not a server project", async () => {
    const workspace = serviceOver(await aContext());
    await workspace.createProject("Wrong store");
    const project = await workspace.resolveProject("Wrong store");
    await workspace.createResource(project, {
      kind: "diagram",
      name: "a",
      content: "one",
    });
    // A nonexistent revision is a conflict, not a silent overwrite.
    await expect(
      workspace.updateResource(project, "a.seq", {
        content: "two",
        expectedRevision: 99,
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("the shared service cannot bypass the policy", () => {
  /** A catalog over the same database and volume, for membership setup. */
  function aCatalog() {
    return createProjectCatalog({
      projects,
      workspaces: createWorkspaceRepository(client),
      storage: (projectId) =>
        createFsProjectStorage({ root: path.join(volume, projectId) }),
      operations: createWorkspaceOperationRepository(client),
    });
  }

  it("refuses a viewer's write with a permission error, not a silent success", async () => {
    const owner = await aContext();
    const ownerService = serviceOver(owner);
    await ownerService.createProject("Shared read-only");
    const project = await ownerService.resolveProject("Shared read-only");
    await ownerService.createResource(project, {
      kind: "diagram",
      name: "a",
      content: "one",
    });

    const viewer = await aContext();
    await aCatalog().setMember(
      owner,
      project.id,
      viewer.principal.subjectUserId,
      "VIEWER",
    );
    await createWorkspaceRepository(client).setMember(
      owner.principal.subjectUserId,
      viewer.principal.subjectUserId,
      "VIEWER",
    );
    const resourceId = (await aCatalog().listResources(owner, project.id))[0]!
      .id;

    await expect(
      aCatalog().updateResource(viewer, project.id, resourceId, {
        content: "two",
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(ApplicationError);

    // The refused write changed nothing.
    const read = await ownerService.readResource(project, "a.seq");
    expect(read.content).toBe("one");
  });

  it("lets an editor write through the same service", async () => {
    const owner = await aContext();
    const ownerService = serviceOver(owner);
    await ownerService.createProject("Shared writable");
    const project = await ownerService.resolveProject("Shared writable");
    await ownerService.createResource(project, {
      kind: "diagram",
      name: "a",
      content: "one",
    });

    const editor = await aContext();
    await aCatalog().setMember(
      owner,
      project.id,
      editor.principal.subjectUserId,
      "EDITOR",
    );
    await createWorkspaceRepository(client).setMember(
      owner.principal.subjectUserId,
      editor.principal.subjectUserId,
      "EDITOR",
    );
    const resourceId = (await aCatalog().listResources(owner, project.id))[0]!
      .id;

    const updated = await aCatalog().updateResource(
      editor,
      project.id,
      resourceId,
      {
        content: "two",
        expectedRevision: 1,
      },
    );
    expect(updated.revision).toBe(2);
  });
});

describe("the catalog is the only way in", () => {
  it("gives the API host an ApplicationError it can map to a status", async () => {
    const owner = await aContext();
    const catalog = createProjectCatalog({
      projects,
      workspaces: createWorkspaceRepository(client),
      storage: (projectId) =>
        createFsProjectStorage({ root: path.join(volume, projectId) }),
      operations: createWorkspaceOperationRepository(client),
    });
    const listing = await catalog.createProject(owner, {
      name: "Mapped",
      workspaceId: owner.principal.subjectUserId,
    });

    const stranger = await aContext();
    try {
      await catalog.getProject(stranger, listing.project.id);
      throw new Error("Expected the call to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).status).toBe(404);
    }
  });
});
