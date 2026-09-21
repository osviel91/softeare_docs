import { afterEach, describe, expect, it } from "vitest";
import { META_SERVER_INFO, type JsonRpcResponse } from "../protocol";
import {
  DOCUMENTING_GUIDE_URI,
  EVENT_FLOW_DSL_URI,
  MARKDOWN_URI,
  SEQUENCE_DSL_URI,
  WORKFLOW_GUIDE_URI,
} from "../reference";
import { createMcpServer, type McpServer } from "../server";
import { makeTempWorkspace, type TempWorkspace } from "./temp-workspace";

/** The shape of a `tools/call` result this server produces. */
interface CallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  resultType?: string;
}

describe("McpServer", () => {
  let temp: TempWorkspace;
  let server: McpServer;
  let nextId = 1;

  afterEach(async () => {
    if (temp) await temp.cleanup();
  });

  async function start(defaultProject?: string): Promise<McpServer> {
    temp = await makeTempWorkspace();
    server = createMcpServer({
      workspaceRoot: temp.root,
      ...(defaultProject === undefined ? {} : { defaultProject }),
    });
    return server;
  }

  /** Send a request and require a response. */
  async function request(
    method: string,
    params?: unknown,
  ): Promise<JsonRpcResponse> {
    const response = await server.handle({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      ...(params === undefined ? {} : { params }),
    });
    if (!response) throw new Error(`no response for ${method}`);
    return response;
  }

  /** Call a tool and return its result, requiring success. */
  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallResult> {
    const response = await request("tools/call", {
      name,
      arguments: args,
    });
    expect(response.error).toBeUndefined();
    const result = response.result as CallResult;
    expect(result.isError).toBe(false);
    return result;
  }

  /** Call a tool expecting a tool-execution error, and return its message. */
  async function callToolExpectingError(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const response = await request("tools/call", {
      name,
      arguments: args,
    });
    const result = response.result as CallResult;
    expect(result.isError).toBe(true);
    return result.content[0].text;
  }

  /** Seed a project with one diagram, without going through the tool layer. */
  async function seedProject(): Promise<void> {
    await callTool("create_project", { name: "Payments" });
    await callTool("create_resource", {
      project: "Payments",
      kind: "diagram",
      name: "checkout",
      title: "Checkout",
      content:
        "actor Customer\nparticipant API\nCustomer ->> API: Pay\nAPI -->> Customer: Paid\n",
    });
    await callTool("create_resource", {
      project: "Payments",
      kind: "note",
      name: "overview",
      title: "Payments overview",
      content: "An overview of the payment system and its checkout flow.",
    });
  }

  it("answers the legacy initialize handshake", async () => {
    await start();
    const response = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "probe", version: "1.0.0" },
    });
    const result = response.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(Object.keys(result.capabilities as object).sort()).toEqual([
      "prompts",
      "resources",
      "tools",
    ]);
    expect(result.serverInfo).toMatchObject({ name: "sequencediagrams" });
    expect(String(result.instructions)).toContain("validate_source");
  });

  it("falls back to a legacy default for an unknown legacy version", async () => {
    await start();
    const response = await request("initialize", {
      protocolVersion: "1900-01-01",
      capabilities: {},
    });
    expect((response.result as Record<string, unknown>).protocolVersion).toBe(
      "2025-06-18",
    );
  });

  it("answers server/discover for a modern client", async () => {
    await start();
    const response = await request("server/discover", {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    });
    const result = response.result as Record<string, unknown>;
    expect(result.resultType).toBe("complete");
    expect(result.supportedVersions).toContain("2026-07-28");
    expect(result.capabilities).toBeDefined();
    expect(
      (result._meta as Record<string, unknown>)[META_SERVER_INFO],
    ).toBeDefined();
    expect(result.ttlMs).toBeTypeOf("number");
  });

  it("rejects a modern request for a version it does not implement", async () => {
    await start();
    const response = await request("tools/list", {
      _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
    });
    expect(response.error?.code).toBe(-32022);
    expect(
      (response.error?.data as { supported: string[] }).supported,
    ).toContain("2026-07-28");
  });

  it("lists a deterministic, well-described tool catalog", async () => {
    await start();
    const response = await request("tools/list");
    const result = response.result as {
      tools: Array<Record<string, unknown>>;
      resultType: string;
    };
    expect(result.resultType).toBe("complete");
    expect(result.tools.length).toBe(17);
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "list_projects",
      "create_project",
      "get_project_overview",
      "list_resources",
      "read_resource",
      "get_outline",
      "search_documentation",
      "find_references",
      "create_resource",
      "update_resource",
      "rename_resource",
      "delete_resource",
      "validate_source",
      "validate_resource",
      "validate_project",
      "render_diagram",
      "audit_documentation",
    ]);
    for (const tool of result.tools) {
      expect(String(tool.description).length).toBeGreaterThan(80);
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      const annotations = tool.annotations as Record<string, unknown>;
      expect(typeof annotations.readOnlyHint).toBe("boolean");
    }
    // Reading tools are marked read-only; deletion is marked destructive.
    const byName = new Map(
      result.tools.map((tool) => [tool.name as string, tool]),
    );
    expect(
      (byName.get("list_resources")!.annotations as Record<string, unknown>)
        .readOnlyHint,
    ).toBe(true);
    expect(
      (byName.get("delete_resource")!.annotations as Record<string, unknown>)
        .destructiveHint,
    ).toBe(true);
    expect(
      (byName.get("create_resource")!.annotations as Record<string, unknown>)
        .readOnlyHint,
    ).toBe(false);
  });

  it("returns a protocol error for an unknown tool", async () => {
    await start();
    const response = await request("tools/call", {
      name: "does_not_exist",
      arguments: {},
    });
    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain("Unknown tool");
  });

  it("returns a protocol error for an unknown method", async () => {
    await start();
    const response = await request("not/a/method");
    expect(response.error?.code).toBe(-32601);
  });

  it("ignores notifications", async () => {
    await start();
    const response = await server.handle({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response).toBe(null);
  });

  it("rejects a malformed envelope", async () => {
    await start();
    const response = await server.handle({ id: 1, method: "tools/list" });
    expect(response?.error?.code).toBe(-32600);
    expect(response?.id).toBe(null);
  });

  it("runs the create → validate → read → audit loop", async () => {
    await start();
    await seedProject();

    // A second create of the same file is a tool error with guidance.
    const conflict = await callToolExpectingError("create_resource", {
      project: "Payments",
      kind: "diagram",
      name: "checkout",
      content: "title Other\n",
    });
    expect(conflict).toMatch(/overwrite/);

    const read = await callTool("read_resource", {
      project: "Payments",
      resource: "checkout",
    });
    expect(read.content[0].text).toContain("participant API");

    const validation = await callTool("validate_project", {
      project: "Payments",
    });
    expect(validation.content[0].text).toContain("0 errors");

    const audit = await callTool("audit_documentation", {
      project: "Payments",
    });
    const auditPayload = audit.structuredContent as {
      summary: { resources: number };
      findings: Array<{ code: string }>;
    };
    expect(auditPayload.summary.resources).toBe(2);
    expect(Array.isArray(auditPayload.findings)).toBe(true);

    const resources = await callTool("list_resources", {
      project: "Payments",
    });
    const listed = resources.structuredContent as {
      resources: Array<{ id: string }>;
    };
    expect(listed.resources.map((entry) => entry.id).sort()).toEqual([
      "diagram-checkout",
      "doc-overview",
    ]);
  });

  it("validates draft text and reports diagnostics as a tool error is not needed", async () => {
    await start();
    const response = await request("tools/call", {
      name: "validate_source",
      arguments: { content: "A ->> B: undeclared", kind: "diagram" },
    });
    const result = response.result as CallResult;
    expect(result.isError).toBe(false);
    const diagnostics = (
      result.structuredContent as {
        diagnostics: Array<{ severity: string; line?: number }>;
      }
    ).diagnostics;
    expect(diagnostics.some((entry) => entry.severity === "error")).toBe(true);
    expect(diagnostics[0].line).toBeTypeOf("number");
  });

  it("rejects a delete that is not confirmed", async () => {
    await start();
    await seedProject();
    const message = await callToolExpectingError("delete_resource", {
      project: "Payments",
      resource: "checkout",
      confirm: false,
    });
    expect(message).toMatch(/confirmation/i);

    await callTool("delete_resource", {
      project: "Payments",
      resource: "checkout",
      confirm: true,
    });
    const listing = await callTool("list_resources", { project: "Payments" });
    expect(
      (listing.structuredContent as { resources: unknown[] }).resources,
    ).toHaveLength(1);
  });

  it("serves the static reference resources", async () => {
    await start();
    const response = await request("resources/list");
    const result = response.result as {
      resources: Array<{ uri: string }>;
      resultType: string;
    };
    expect(result.resultType).toBe("complete");
    expect(result.resources.map((entry) => entry.uri)).toEqual([
      SEQUENCE_DSL_URI,
      EVENT_FLOW_DSL_URI,
      MARKDOWN_URI,
      DOCUMENTING_GUIDE_URI,
      WORKFLOW_GUIDE_URI,
    ]);

    const read = await request("resources/read", { uri: SEQUENCE_DSL_URI });
    const contents = (
      read.result as { contents: Array<{ text: string; mimeType: string }> }
    ).contents;
    expect(contents[0].mimeType).toBe("text/markdown");
    expect(contents[0].text).toContain("### Participant");
    expect(contents[0].text).toContain("### Note on a message");

    const eventFlow = await request("resources/read", {
      uri: EVENT_FLOW_DSL_URI,
    });
    expect(
      (eventFlow.result as { contents: Array<{ text: string }> }).contents[0]
        .text,
    ).toContain("### Publication");
  });

  it("reads a project resource through its URI template", async () => {
    await start();
    await seedProject();
    const response = await request("resources/read", {
      uri: "sequencediagrams://project/Payments/resource/checkout.seq",
    });
    const contents = (response.result as { contents: Array<{ text: string }> })
      .contents;
    expect(contents[0].text).toContain("Customer ->> API: Pay");
  });

  it("returns -32602 for a resource that does not exist", async () => {
    await start();
    const response = await request("resources/read", {
      uri: "sequencediagrams://reference/nope",
    });
    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain("Resource not found");
  });

  it("serves prompts and resolves their arguments", async () => {
    await start();
    const list = await request("prompts/list");
    const prompts = (list.result as { prompts: Array<{ name: string }> })
      .prompts;
    expect(prompts.map((entry) => entry.name)).toEqual([
      "document-application",
      "improve-documentation",
      "diagram-interaction-flow",
      "model-event-driven-architecture",
    ]);

    const get = await request("prompts/get", {
      name: "document-application",
      arguments: { project: "Payments", system: "the checkout service" },
    });
    const messages = (
      get.result as {
        messages: Array<{ role: string; content: { text: string } }>;
      }
    ).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content.text).toContain("the checkout service");
    expect(messages[0].content.text).toContain("Payments");
    expect(messages[0].content.text).toContain(SEQUENCE_DSL_URI);

    // A required argument is enforced.
    const missing = await request("prompts/get", {
      name: "diagram-interaction-flow",
      arguments: {},
    });
    expect(missing.error?.code).toBe(-32602);

    const unknown = await request("prompts/get", { name: "nope" });
    expect(unknown.error?.code).toBe(-32602);
  });

  it("uses the configured default project when a tool omits it", async () => {
    await start("Payments");
    await callTool("create_project", { name: "Payments" });
    await callTool("create_resource", {
      kind: "diagram",
      name: "solo",
      content: "participant A\nparticipant B\nA ->> B: hi\n",
    });
    const listing = await callTool("list_resources", {});
    const resources = (
      listing.structuredContent as { resources: Array<{ path: string }> }
    ).resources;
    expect(resources.map((entry) => entry.path)).toEqual(["solo.seq"]);
  });

  it("explains an ambiguous project choice", async () => {
    await start();
    await callTool("create_project", { name: "One" });
    await callTool("create_project", { name: "Two" });
    const message = await callToolExpectingError("list_resources", {});
    expect(message).toMatch(/project/i);
    expect(message).toContain("One");
    expect(message).toContain("Two");
  });

  it("renders a diagram as SVG through the tool", async () => {
    await start();
    await seedProject();
    const rendered = await callTool("render_diagram", {
      project: "Payments",
      resource: "checkout",
      theme: "dark",
    });
    const payload = rendered.structuredContent as {
      format: string;
      svg?: string;
      width: number;
    };
    expect(payload.format).toBe("svg");
    expect(payload.svg).toContain("<svg");
    expect(payload.width).toBeGreaterThan(0);
    expect(rendered.content[0].text).toContain("<svg");
  });
});
