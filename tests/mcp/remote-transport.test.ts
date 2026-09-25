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
import { MCP_INSTRUCTIONS } from "../../apps/mcp/mcp/server";
import { createMcpTools } from "../../apps/mcp/mcp/tools";
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
  it("keeps initialize guidance aligned with exposed tool names", () => {
    const tools = new Set(createMcpTools().map((tool) => tool.name));
    const numberedTools = [
      ...MCP_INSTRUCTIONS.matchAll(/^\d+\.\s+([a-z_]+)/gm),
    ].map((match) => match[1]);
    expect(numberedTools.length).toBeGreaterThan(0);
    expect(numberedTools.filter((name) => !tools.has(name))).toEqual([]);
  });

  it("guides agents to the existing metadata discovery operations", () => {
    expect(MCP_INSTRUCTIONS).toContain("get_resource_metadata");
    expect(MCP_INSTRUCTIONS).toContain("search_project");
    expect(MCP_INSTRUCTIONS).toContain("semantic metadata");
    expect(MCP_INSTRUCTIONS).toContain("descriptions and tags");
  });

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
    expect(names).toContain("list_resource_relationships");
    expect(names).toContain("create_resource_relationship");
    // A write tool must not claim to be read-only.
    const update = tools.find((tool) => tool.name === "update_resource");
    expect(update?.annotations?.readOnlyHint).toBe(false);
    const read = tools.find((tool) => tool.name === "read_resource");
    expect(read?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("lets an external client discover and author causal Event Flow syntax", async () => {
    const client = await connect(token);
    expect(client.getInstructions()).toContain(
      "unsupported representation gap, not an automatic Markdown conversion",
    );
    expect(client.getInstructions()).toContain(
      "genuinely a useful cross-cutting Note",
    );
    expect(client.getInstructions()).toContain(
      "orthogonal projections, not mutually exclusive classifications",
    );
    expect(client.getInstructions()).toContain(
      "Do not mechanically duplicate every Sequence",
    );
    const listed = await client.listResources();
    const reference = listed.resources.find((entry) =>
      entry.uri.endsWith("/reference/event-flow-dsl"),
    );
    expect(reference).toBeDefined();
    const referenceRead = await client.readResource({ uri: reference!.uri });
    const guidance = (referenceRead.contents[0] as { text: string }).text;
    for (const phrase of [
      "handler <id>",
      "handled by",
      "causes",
      "effect <id>",
      "provenance: external|internal|unknown",
    ]) {
      expect(guidance).toContain(phrase);
    }

    const created = await client.callTool({
      name: "upsert_event_flow",
      arguments: {
        projectId,
        path: "causal.eventseq",
        content: [
          "title Minimal causal flow",
          "event Input {",
          "  provenance: external",
          "}",
          "event Output",
          "handler HandleInput",
          "Input handled by HandleInput",
          "effect persist-input on HandleInput kind state-update: Persist input",
          "HandleInput causes Output",
        ].join("\n"),
      },
    });
    expect(created.isError).toBeFalsy();

    const invalid = await client.callTool({
      name: "upsert_event_flow",
      arguments: {
        projectId,
        path: "invalid-causal.eventseq",
        content: "event Input\nInput handled by MissingHandler",
      },
    });
    expect(invalid.isError).toBe(true);
    expect(structured(invalid).error.details.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "eventflow.unknown-handler" }),
      ]),
    );
    await client.close();
  });

  it("lets an external client discover, create, validate and rediscover typed complementary views", async () => {
    const client = await connect(token);
    expect(client.getInstructions()).toContain(
      "Prose such as \"complements X\" in a description is not a replacement",
    );
    expect(client.getInstructions()).toContain(
      "complementary projections of substantially the same behavior",
    );

    const sequence = await client.callTool({
      name: "upsert_sequence_diagram",
      arguments: {
        projectId,
        path: "typed-complementary.seq",
        content: "title Typed complementary\n",
      },
    });
    const flow = await client.callTool({
      name: "upsert_event_flow",
      arguments: {
        projectId,
        path: "typed-complementary.eventseq",
        content: "title Typed causal\nevent Input\n",
      },
    });
    expect(sequence.isError).toBeFalsy();
    expect(flow.isError).toBeFalsy();

    const sequenceId = structured(sequence).resource.id;
    const flowId = structured(flow).resource.id;
    const before = await client.callTool({
      name: "list_resource_relationships",
      arguments: { projectId },
    });
    expect(structured(before).relationships).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: sequenceId, targetId: flowId }),
      ]),
    );

    const created = await client.callTool({
      name: "create_resource_relationship",
      arguments: {
        projectId,
        source: sequenceId,
        target: flowId,
        sourceRole: "execution",
        targetRole: "causal",
      },
    });
    expect(created.isError).toBeFalsy();
    expect(structured(created).relationship).toEqual(
      expect.objectContaining({
        kind: "complementary-view",
        sourceId: expect.any(String),
        targetId: expect.any(String),
        sourceRole: "execution",
        targetRole: "causal",
      }),
    );

    const after = await client.callTool({
      name: "list_resource_relationships",
      arguments: { projectId },
    });
    expect(structured(after).relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "complementary-view",
          sourceRole: "execution",
          targetRole: "causal",
        }),
      ]),
    );
    const listed = await client.callTool({
      name: "list_resources",
      arguments: { projectId },
    });
    expect(structured(listed).relationships).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "complementary-view" })]),
    );

    const self = await client.callTool({
      name: "create_resource_relationship",
      arguments: { projectId, source: sequenceId, target: sequenceId },
    });
    expect(self.isError).toBe(true);
    const dangling = await client.callTool({
      name: "create_resource_relationship",
      arguments: { projectId, source: sequenceId, target: "missing-resource" },
    });
    expect(dangling.isError).toBe(true);
    await client.close();
  });

  it("creates a project when the credential has project:create", async () => {
    const bootstrapOwner = await harness.aUser("Bootstrap owner");
    const bootstrapToken = (
      await harness.aToken(bootstrapOwner, ["project:create", "project:read"])
    ).token;
    const client = await connect(bootstrapToken);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("create_project");

    const created = await client.callTool({
      name: "create_project",
      arguments: { name: "Created through MCP" },
    });
    expect(created.isError).toBeFalsy();
    expect(structured(created).project.name).toBe("Created through MCP");
    expect(structured(created).role).toBe("OWNER");

    const listed = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    expect(structured(listed).projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Created through MCP", role: "OWNER" }),
      ]),
    );
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
