/**
 * The remote MCP service, driven by the official MCP client SDK (Phase 6 §62).
 *
 * Every assertion here goes through a real socket with real Streamable HTTP: an
 * `initialize` handshake, `tools/list`, `tools/call`, `resources/list` and
 * `resources/read`. That is deliberate — the mission asks for an integration
 * client rather than hand-built HTTP calls, because a hand-built call proves the
 * test understands the transport, not that the server does.
 */
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHarness, type McpHarness } from "./harness";

let harness: McpHarness;
let ownerId: string;
let projectId: string;
let token: string;

beforeAll(async () => {
  harness = await startHarness();
  ownerId = await harness.aUser();
  projectId = await harness.aProject(ownerId);
  token = (await harness.aToken(ownerId)).token;
});

afterAll(async () => {
  await harness.close();
});

/** Connect a client with a bearer token. */
async function connect(bearer: string | null): Promise<Client> {
  const client = new Client({ name: "sdm-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(harness.url), {
      requestInit: {
        headers: bearer === null ? {} : { Authorization: `Bearer ${bearer}` },
      },
    }),
  );
  return client;
}

/** The structured content of a successful tool call. */
function structured(result: unknown): Record<string, any> {
  return (
    (result as { structuredContent?: Record<string, any> }).structuredContent ??
    {}
  );
}

describe("the remote MCP service over Streamable HTTP", () => {
  it("negotiates a protocol version the SDK implements", async () => {
    const client = await connect(token);
    const version = client.getServerVersion();
    expect(version?.name).toBe("sequencediagrams-mcp");
    expect(client.getInstructions()).toContain("list_projects");
    await client.close();
  });

  it("advertises the semantic and primitive tools", async () => {
    const client = await connect(token);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("read_resource");
    expect(names).toContain("update_resource");
    expect(names).toContain("upsert_sequence_diagram");
    expect(names).toContain("validate_project");
    expect(names).toContain("search_project");
    // A write tool must not claim to be read-only.
    const update = tools.find((tool) => tool.name === "update_resource");
    expect(update?.annotations?.readOnlyHint).toBe(false);
    const read = tools.find((tool) => tool.name === "read_resource");
    expect(read?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("lists projects and reports the caller's role", async () => {
    const client = await connect(token);
    const result = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const data = structured(result);
    expect(Array.isArray(data.projects)).toBe(true);
    expect(data.projects[0].id).toBe(projectId);
    expect(data.projects[0].role).toBe("OWNER");
    await client.close();
  });

  it("creates, reads, updates and moves a resource", async () => {
    const client = await connect(token);

    const created = await client.callTool({
      name: "create_resource",
      arguments: {
        projectId,
        path: "checkout.seq",
        type: "sequence-diagram",
        content: "title Checkout\n",
      },
    });
    expect(created.isError).toBeFalsy();
    const resource = structured(created).resource;
    expect(resource.path).toBe("checkout.seq");
    expect(resource.revision).toBe(1);

    const read = await client.callTool({
      name: "read_resource",
      arguments: { projectId, resource: "checkout.seq" },
    });
    expect(structured(read).content).toBe("title Checkout\n");
    expect(structured(read).resource.revision).toBe(1);

    const updated = await client.callTool({
      name: "update_resource",
      arguments: {
        projectId,
        resource: resource.id,
        content: "title Checkout v2\n",
        expectedRevision: 1,
      },
    });
    expect(updated.isError).toBeFalsy();
    expect(structured(updated).resource.revision).toBe(2);

    const moved = await client.callTool({
      name: "move_resource",
      arguments: {
        projectId,
        resource: resource.id,
        path: "payments/checkout.seq",
        expectedRevision: 2,
      },
    });
    expect(moved.isError).toBeFalsy();
    expect(structured(moved).resource.path).toBe("payments/checkout.seq");

    await client.close();
  });

  it("returns a conflict as a tool error the model can act on", async () => {
    const client = await connect(token);
    const listed = await client.callTool({
      name: "list_resources",
      arguments: { projectId },
    });
    const resource = (structured(listed).resources as any[]).find(
      (entry) => entry.path === "payments/checkout.seq",
    );

    const stale = await client.callTool({
      name: "update_resource",
      arguments: {
        projectId,
        resource: resource.id,
        content: "title Stale\n",
        expectedRevision: 1,
      },
    });
    expect(stale.isError).toBe(true);
    expect(structured(stale).error.code).toBe("conflict");
    await client.close();
  });

  it("validates before writing a semantic upsert", async () => {
    const client = await connect(token);
    const bad = await client.callTool({
      name: "upsert_sequence_diagram",
      arguments: {
        projectId,
        path: "broken.seq",
        content: "this is not a diagram at all ][\n",
      },
    });
    expect(bad.isError).toBe(true);
    expect(structured(bad).error.code).toBe("validation");

    // Nothing was written.
    const listed = await client.callTool({
      name: "list_resources",
      arguments: { projectId },
    });
    expect(
      (structured(listed).resources as any[]).some(
        (entry) => entry.path === "broken.seq",
      ),
    ).toBe(false);
    await client.close();
  });

  it("reads project content as MCP resources, not public URLs", async () => {
    const client = await connect(token);
    const listed = await client.listResources();
    expect(listed.resources.length).toBeGreaterThan(0);
    const resource = listed.resources.find((entry) =>
      entry.uri.includes("resources/"),
    );
    expect(resource).toBeDefined();
    const read = await client.readResource({ uri: resource!.uri });
    const first = read.contents[0] as { text?: string };
    expect(typeof first.text).toBe("string");
    await client.close();
  });

  it("paginates a listing without returning the whole project", async () => {
    const client = await connect(token);
    // Two resources are needed before a one-item page can have a successor.
    await client.callTool({
      name: "create_resource",
      arguments: {
        projectId,
        path: "second.seq",
        type: "sequence-diagram",
        content: "title Second\n",
      },
    });
    const first = await client.callTool({
      name: "list_resources",
      arguments: { projectId, limit: 1 },
    });
    const data = structured(first);
    expect(data.resources).toHaveLength(1);
    expect(typeof data.nextCursor).toBe("string");

    const second = await client.callTool({
      name: "list_resources",
      arguments: { projectId, limit: 1, cursor: data.nextCursor },
    });
    expect(structured(second).resources[0].id).not.toBe(data.resources[0].id);
    await client.close();
  });

  it("searches a project and returns snippets rather than files", async () => {
    const client = await connect(token);
    const result = await client.callTool({
      name: "search_project",
      arguments: { projectId, query: "Checkout" },
    });
    expect(result.isError).toBeFalsy();
    const data = structured(result);
    expect(Array.isArray(data.results)).toBe(true);
    for (const hit of data.results) {
      expect(hit.snippet.length).toBeLessThan(400);
      expect(hit.path).toBeDefined();
    }
    await client.close();
  });

  it("validates a project and reports diagnostics", async () => {
    const client = await connect(token);
    const result = await client.callTool({
      name: "validate_project",
      arguments: { projectId },
    });
    expect(result.isError).toBeFalsy();
    expect(Array.isArray(structured(result).diagnostics)).toBe(true);
    await client.close();
  });
});
