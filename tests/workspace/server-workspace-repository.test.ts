/**
 * The browser's server adapter (Phase 4A).
 *
 * These tests run the real {@link ServerWorkspaceRepository} against a fake HTTP
 * API rather than a stubbed repository: the point of this layer is the *wire*
 * — which method, which path, which revision — so mocking it away would test
 * nothing. The fake speaks the same JSON envelopes the real API does (including
 * the `409` body a stale write receives), which is what lets a conflict test be
 * meaningful without a database.
 */
import { describe, expect, it } from "vitest";
import { ServerApiClient } from "../../src/workspace/server/api-client";
import {
  createServerWorkspaceRepository,
  supportsForcedWrite,
} from "../../src/workspace/server/server-workspace-repository";
import {
  AccessDeniedError,
  AuthenticationRequiredError,
  NetworkError,
  RevisionConflictError,
  ValidationFailedError,
} from "../../src/workspace/server/api-errors";
import { isOk } from "../../src/shared/result/result";

/** A resource the fake API stores. */
interface StoredResource {
  id: string;
  projectId: string;
  path: string;
  type: "sequence-diagram" | "event-flow" | "markdown-document";
  revision: number;
  content: string;
}

/** A recorded request, for asserting the wire shape. */
interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** The fake API and the handles a test needs. */
interface FakeApi {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  resources: Map<string, StoredResource>;
  calls: Call[];
}

/** Build a response the client can read: it only uses `ok`, `status`, `text`. */
function reply(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body === undefined ? "" : JSON.stringify(body);
    },
  } as unknown as Response;
}

/** The error envelope the API uses. */
function failure(status: number, code: string, details?: unknown): Response {
  return reply(status, {
    error: {
      code,
      message: `refused: ${code}`,
      ...(details ? { details } : {}),
    },
  });
}

/** A fake API holding one project, with the subset of routes the adapter uses. */
function createFakeApi(
  options: { writable?: boolean; projectId?: string } = {},
): FakeApi {
  const projectId = options.projectId ?? "p1";
  const resources = new Map<string, StoredResource>();
  const calls: Call[] = [];
  // Start well above the ids tests seed by hand, so a generated id can never
  // collide with a fixture and silently overwrite it.
  let sequence = 1000;

  const find = (id: string): StoredResource | undefined => resources.get(id);
  const byPath = (path: string): StoredResource | undefined =>
    [...resources.values()].find((resource) => resource.path === path);

  const fetch = async (
    input: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input, "http://api.test");
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : null;
    calls.push({ method, path, body });

    if (!options.writable && method !== "GET") {
      return failure(403, "forbidden");
    }

    // GET /api/projects/:id/resources
    const listMatch = /^\/api\/projects\/([^/]+)\/resources$/.exec(path);
    if (listMatch) {
      if (method === "GET") {
        return reply(200, {
          resources: [...resources.values()].map((resource) => ({
            id: resource.id,
            projectId: resource.projectId,
            path: resource.path,
            type: resource.type,
            revision: resource.revision,
          })),
        });
      }
      if (method === "POST") {
        const input_ = body as {
          path: string;
          type: StoredResource["type"];
          content: string;
        };
        if (byPath(input_.path)) return failure(409, "conflict");
        sequence += 1;
        const resource: StoredResource = {
          id: `r${sequence}`,
          projectId,
          path: input_.path,
          type: input_.type,
          revision: 1,
          content: input_.content,
        };
        resources.set(resource.id, resource);
        return reply(201, { resource: view(resource) });
      }
    }

    // /api/projects/:id/resources/:resourceId[/move]
    const oneMatch =
      /^\/api\/projects\/([^/]+)\/resources\/([^/]+)(\/move)?$/.exec(path);
    if (oneMatch) {
      const id = decodeURIComponent(oneMatch[2]);
      const resource = find(id);
      if (!resource) return failure(404, "not_found");
      if (method === "GET") {
        return reply(200, {
          resource: view(resource),
          content: resource.content,
        });
      }
      if (method === "PUT") {
        const input_ = body as {
          content: string;
          expectedRevision: number;
        };
        if (input_.expectedRevision !== resource.revision) {
          return failure(409, "conflict", {
            expectedRevision: input_.expectedRevision,
            currentRevision: resource.revision,
          });
        }
        resource.content = input_.content;
        resource.revision += 1;
        return reply(200, { resource: view(resource) });
      }
      if (method === "DELETE") {
        resources.delete(id);
        return reply(204);
      }
      if (method === "POST" && oneMatch[3] === "/move") {
        const input_ = body as { path: string; expectedRevision: number };
        if (input_.expectedRevision !== resource.revision) {
          return failure(409, "conflict", {
            expectedRevision: input_.expectedRevision,
            currentRevision: resource.revision,
          });
        }
        const occupant = byPath(input_.path);
        if (occupant && occupant.id !== id) return failure(409, "conflict");
        resource.path = input_.path;
        resource.revision += 1;
        return reply(200, { resource: view(resource) });
      }
    }

    // PATCH /api/projects/:id
    const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
    if (projectMatch && method === "PATCH") {
      const input_ = body as { name?: string };
      return reply(200, {
        project: {
          id: projectId,
          name: input_.name ?? "P",
          slug: "p",
          ownerId: "u1",
          role: "OWNER",
          resourceCount: resources.size,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      });
    }

    return failure(404, "not_found");
  };

  return { fetch, resources, calls };
}

/** The wire view of a resource. */
function view(resource: StoredResource): Record<string, unknown> {
  return {
    id: resource.id,
    projectId: resource.projectId,
    path: resource.path,
    type: resource.type,
    revision: resource.revision,
  };
}

/** Build the adapter over a fake API, seeding resources through the fake. */
function build(options: { writable?: boolean; seed?: StoredResource[] } = {}) {
  const writable = options.writable ?? true;
  const api = createFakeApi({ writable });
  for (const resource of options.seed ?? []) {
    api.resources.set(resource.id, { ...resource });
  }
  const client = new ServerApiClient({
    fetch: api.fetch,
  });
  const repository = createServerWorkspaceRepository({
    client,
    projectId: "p1",
    projectName: "Project A",
    writable,
  });
  return { api, client, repository };
}

/** A stored diagram. */
function diagram(overrides: Partial<StoredResource> = {}): StoredResource {
  return {
    id: "r1",
    projectId: "p1",
    path: "checkout.seq",
    type: "sequence-diagram",
    revision: 3,
    content: "title Checkout",
    ...overrides,
  };
}

describe("ServerWorkspaceRepository", () => {
  it("lists diagrams and notes from the resource rows", async () => {
    const { repository } = build({
      seed: [
        diagram(),
        diagram({
          id: "r2",
          path: "orders.eventseq",
          type: "event-flow",
          content: "event OrderCreated",
        }),
        diagram({
          id: "r3",
          path: "runbook.md",
          type: "markdown-document",
          content: "# Runbook",
        }),
      ],
    });

    const diagrams = await repository.listDiagramFiles("p1");
    const notes = await repository.listNoteFiles("p1");
    expect(isOk(diagrams) && diagrams.value.map((file) => file.name)).toEqual([
      "checkout.seq",
      "orders.eventseq",
    ]);
    expect(isOk(notes) && notes.value.map((note) => note.name)).toEqual([
      "runbook.md",
    ]);
    // The server's database id is the file's id; the path is its name.
    expect(isOk(diagrams) && diagrams.value[0].id).toBe("r1");
  });

  it("creates a diagram under a free name with the server's extension", async () => {
    const { repository, api } = build({ seed: [diagram()] });

    const first = await repository.createEmptyDiagram("p1");
    const second = await repository.createEmptyDiagram("p1");

    expect(isOk(first) && first.value.name).toBe("Untitled.seq");
    expect(isOk(second) && second.value.name).toBe("Untitled 2.seq");
    expect(api.resources.size).toBe(3);
  });

  it("creates notes with the markdown seed and extension", async () => {
    const { repository } = build();
    const created = await repository.createEmptyNote("p1");
    expect(isOk(created) && created.value.name).toBe("Untitled.md");
    expect(isOk(created) && created.value.markdown).toBe("# Untitled\n");
  });

  it("saves with the revision it last read", async () => {
    const { repository, api } = build({ seed: [diagram()] });
    await repository.listDiagramFiles("p1");

    const saved = await repository.saveDiagramFile("p1", {
      id: "r1",
      name: "checkout.seq",
      source: "title Checkout v2",
      projectId: "p1",
    });

    expect(isOk(saved)).toBe(true);
    const put = api.calls.find((call) => call.method === "PUT");
    expect(put?.body).toEqual({
      content: "title Checkout v2",
      expectedRevision: 3,
    });
    expect(api.resources.get("r1")?.revision).toBe(4);
  });

  it("reports a stale write as a revision conflict, carrying both revisions", async () => {
    const { repository, api } = build({ seed: [diagram()] });
    await repository.listDiagramFiles("p1");
    // Someone else writes between this client's read and its save.
    const stored = api.resources.get("r1");
    if (stored) stored.revision = 9;

    const saved = await repository.saveDiagramFile("p1", {
      id: "r1",
      name: "checkout.seq",
      source: "mine",
      projectId: "p1",
    });

    expect(isOk(saved)).toBe(false);
    if (isOk(saved)) return;
    expect(saved.error).toBeInstanceOf(RevisionConflictError);
    const conflict = saved.error as RevisionConflictError;
    expect(conflict.expectedRevision).toBe(3);
    expect(conflict.currentRevision).toBe(9);
    // The refused write changed nothing.
    expect(api.resources.get("r1")?.content).toBe("title Checkout");
  });

  it("looks a resource up by path when it has no cached revision", async () => {
    const { repository, api } = build({ seed: [diagram()] });

    // No list first: the adapter has the path but has never read the revision.
    const saved = await repository.saveDiagramFile("p1", {
      id: "unseen",
      name: "checkout.seq",
      source: "adopted",
      projectId: "p1",
    });

    expect(isOk(saved)).toBe(true);
    expect(api.resources.get("r1")?.content).toBe("adopted");
    // It updated the existing row rather than creating a second one.
    expect(api.resources.size).toBe(1);
  });

  it("creates a resource whose path is new", async () => {
    const { repository, api } = build();
    const saved = await repository.saveDiagramFile("p1", {
      id: "fresh",
      name: "new-flow.seq",
      source: "title New",
      projectId: "p1",
    });
    expect(isOk(saved)).toBe(true);
    expect(api.resources.size).toBe(1);
    expect([...api.resources.values()][0].path).toBe("new-flow.seq");
  });

  it("renames by moving the path while keeping the id", async () => {
    const { repository } = build({ seed: [diagram()] });
    const renamed = await repository.renameDiagramFile(
      "p1",
      "r1",
      "renamed.seq",
    );
    expect(isOk(renamed) && renamed.value.id).toBe("r1");
    expect(isOk(renamed) && renamed.value.name).toBe("renamed.seq");
  });

  it("adds the markdown extension when a note is renamed without one", async () => {
    const { repository } = build({
      seed: [
        diagram({ id: "n1", path: "notes.md", type: "markdown-document" }),
      ],
    });
    const renamed = await repository.renameNoteFile("p1", "n1", "design");
    expect(isOk(renamed) && renamed.value.name).toBe("design.md");
  });

  it("duplicates with the shared copy-name rule", async () => {
    const { repository } = build({ seed: [diagram()] });
    const copy = await repository.duplicateDiagramFile("p1", "r1");
    expect(isOk(copy) && copy.value.name).toBe("checkout copy.seq");
    expect(isOk(copy) && copy.value.source).toBe("title Checkout");
  });

  it("deletes a resource", async () => {
    const { repository, api } = build({ seed: [diagram()] });
    const removed = await repository.deleteDiagramFile("p1", "r1");
    expect(isOk(removed)).toBe(true);
    expect(api.resources.size).toBe(0);
  });

  it("derives its identity record from the resources table", async () => {
    const { repository } = build({ seed: [diagram()] });
    const metadata = await repository.readProjectMetadata("p1");
    expect(isOk(metadata)).toBe(true);
    if (!isOk(metadata)) return;
    expect(metadata.value?.resources).toEqual([
      { id: "r1", path: "checkout.seq", type: "sequence-diagram" },
    ]);
  });

  it("refuses every write when the caller may only read", async () => {
    const { repository, api } = build({ writable: false, seed: [diagram()] });
    const create = await repository.createEmptyDiagram("p1");
    const save = await repository.saveDiagramFile("p1", {
      id: "r1",
      name: "checkout.seq",
      source: "x",
      projectId: "p1",
    });
    const remove = await repository.deleteDiagramFile("p1", "r1");
    const rename = await repository.renameDiagramFile("p1", "r1", "y.seq");
    expect(isOk(create) || isOk(save) || isOk(remove) || isOk(rename)).toBe(
      false,
    );
    // Reading still works, and nothing was written.
    expect(isOk(await repository.listDiagramFiles("p1"))).toBe(true);
    expect(api.resources.get("r1")?.content).toBe("title Checkout");
  });

  it("addresses exactly one project and refuses another", async () => {
    const { repository } = build();
    const listed = await repository.listProjects();
    expect(isOk(listed) && listed.value.map((project) => project.id)).toEqual([
      "p1",
    ]);
    const stray = await repository.listDiagramFiles("other");
    expect(isOk(stray)).toBe(false);
    const create = await repository.createProject();
    expect(isOk(create)).toBe(false);
  });

  it("renames the project through the catalogue endpoint", async () => {
    const { repository } = build();
    const renamed = await repository.renameProject("p1", "Renamed");
    expect(isOk(renamed) && renamed.value.name).toBe("Renamed");
    const listed = await repository.listProjects();
    expect(isOk(listed) && listed.value[0].name).toBe("Renamed");
  });

  it("overwrites at an explicitly named revision only when asked to", async () => {
    const { repository, api } = build({ seed: [diagram()] });
    expect(supportsForcedWrite(repository)).toBe(true);
    const stored = api.resources.get("r1");
    if (stored) stored.revision = 7;
    await repository.listDiagramFiles("p1");

    // The forced write names the revision the server reported, so it lands...
    const forced = await repository.forceSaveDiagramFile(
      "p1",
      {
        id: "r1",
        name: "checkout.seq",
        source: "overwritten",
        projectId: "p1",
      },
      7,
    );
    expect(isOk(forced)).toBe(true);
    expect(api.resources.get("r1")?.content).toBe("overwritten");

    // ...while a stale forced write is still refused.
    const stale = await repository.forceSaveDiagramFile(
      "p1",
      {
        id: "r1",
        name: "checkout.seq",
        source: "stale",
        projectId: "p1",
      },
      7,
    );
    expect(isOk(stale)).toBe(false);
    expect(api.resources.get("r1")?.content).toBe("overwritten");
  });
});

describe("ServerApiClient error mapping", () => {
  const respond = (status: number, code: string, details?: unknown) =>
    new ServerApiClient({
      fetch: async () => failure(status, code, details),
    });

  it("maps 401 to a sign-in requirement", async () => {
    await expect(respond(401, "unauthorized").me()).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
  });

  it("maps 403 to an access denial", async () => {
    await expect(
      respond(403, "forbidden").listProjects(),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("maps 422 to a validation failure", async () => {
    await expect(
      respond(422, "invalid").createProject("x"),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it("carries the revisions from a 409 body", async () => {
    const client = respond(409, "conflict", {
      expectedRevision: 2,
      currentRevision: 5,
    });
    await expect(
      client.updateResource("p1", "r1", { content: "x", expectedRevision: 2 }),
    ).rejects.toMatchObject({
      name: "RevisionConflictError",
      currentRevision: 5,
      expectedRevision: 2,
      status: 409,
    });
  });

  it("reports an unreachable server as a network failure, not a refusal", async () => {
    const client = new ServerApiClient({
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(client.listProjects()).rejects.toBeInstanceOf(NetworkError);
  });

  it("tolerates a 204 with no body", async () => {
    const client = new ServerApiClient({
      fetch: async () =>
        ({
          ok: true,
          status: 204,
          text: async () => "",
        }) as unknown as Response,
    });
    await expect(client.deleteProject("p1")).resolves.toBeUndefined();
  });
});
