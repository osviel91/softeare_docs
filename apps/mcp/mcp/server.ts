/**
 * The MCP server for one authenticated request (Phase 6 §4–5, §54, §57, §59–61).
 *
 * A fresh `McpServer` is built for every HTTP request and never reused. That is
 * what makes the service stateless in the way the mission requires:
 *
 * ```text
 * request 1 → instance A
 * request 2 → instance B
 * request 3 → instance A
 * ```
 *
 * all work, because no request depends on state another request left in a
 * process. The principal, the tool list and the rate-limit budget all arrive
 * with the request; nothing is remembered between them.
 *
 * ## Why the tools are filtered, and why that is not security
 *
 * `tools/list` omits a tool the credential can never call, so a read-only agent
 * is not advertised a `delete_resource` it would only be refused. That is
 * minimum exposure, not a boundary: the call-time check is repeated inside the
 * tool's use case, and the use case re-checks the project role as well. A client
 * that calls a hidden tool by name is still refused.
 *
 * ## Cancellation and deadlines
 *
 * The SDK hands each call an `AbortSignal` that fires when the client
 * disconnects. {@link createMcpServerForPrincipal} combines it with a deadline,
 * so an expensive `validate_project` cannot outlive the request that asked for
 * it.
 */
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApplicationContext } from "../../../src/application/context";
import type { ProjectCatalog } from "../../../src/application/project-catalog";
import type { ChangeProposalService } from "../../../src/application/change-proposal-service";
import type { ResourceTrajectoryService } from "../../../src/application/resource-trajectory-service";
import { credentialGrants } from "../../../src/application/authorization";
import { forbidden, invalid } from "../../../src/application/errors";
import packageJson from "../../../package.json";
import type { McpConfig } from "../config";
import type { Observability } from "../observability";
import { createMcpTools, type McpTool, type ToolContext } from "./tools";
import { describeMcpError, toMcpError } from "./errors";

/** The server's advertised name. */
export const MCP_SERVER_NAME = "sequencediagrams-mcp";
/** The server's advertised version, from the package it ships in. */
export const MCP_SERVER_VERSION = packageJson.version;

/**
 * The guidance returned by `initialize`.
 *
 * Written for a machine caller: it names the bearer scheme, says what a project
 * contains, insists on reading before writing, and explains the revision
 * contract in the terms a tool result uses. It deliberately does not reproduce
 * the DSL grammar — that is what resources and the documentation tools are for.
 */
export const MCP_INSTRUCTIONS = `This server exposes Software Docs Manager projects to an external agent. Every request is authenticated with a personal access token as \`Authorization: Bearer sdm_pat_…\`; there are no anonymous tools.

A project contains sequence diagrams (\`.seq\`), event flows (\`.eventseq\`) and markdown documents (\`.md\`).

Work in this order:
1. list_projects — the project ids every other tool addresses. If it is empty and the credential has project:create, call create_project.
2. get_project_index or list_resources — see what exists and what your token may do; these responses include semantic metadata when present.
3. read_diagram, read_documentation or read_resource — get the text, semantic metadata and current revision. Use get_resource_metadata when you need metadata without reading the contents; search_project also returns matched descriptions and tags.
4. Prefer the semantic tools for writing: upsert_sequence_diagram, upsert_event_flow and upsert_documentation parse and validate before they persist, and apply the revision for you. Use create_resource/update_resource only when you need raw control.
5. Every write names the revision it read as \`expectedRevision\`. A stale value is refused with a conflict: re-read, then retry at the new revision. Never invent a revision.
6. Resource descriptions and tags are documentary metadata. Use get_resource_metadata to inspect them or update_resource_metadata to replace them without changing text; an empty metadata object clears them.
7. After changing a diagram, call validate_project to see problems.

Event Flow represents asynchronous/event-driven causal behavior. HTTP requests, synchronous calls, reverse-proxy routing, cron invocation, logs/telemetry, and infrastructure topology do not establish an Event Flow by themselves. A project may legitimately contain no Event Flow documentation. Do not force synchronous or structural behavior into Event Flow. When real asynchronous behavior exists, use Event -> Handler -> Effects -> Resulting Events as an investigation heuristic, not a mandatory shape. You may conclude: "No asynchronous event context was observed."

Assessment guidance: INCOMPLETE means the representation and semantic boundary are correct but important knowledge is missing. MISREPRESENTED means the representation's semantics do not match observed behavior; synchronous HTTP routing represented as asynchronous Event Flow is MISREPRESENTED, not merely incomplete.

A token carries scopes. A read-only token cannot write; project membership always applies, so a token can never act outside the projects its owner belongs to. Mutating tools accept an \`idempotencyKey\`; a retry with the same key performs the mutation once.`;

/** Options for building a request's server. */
export interface McpServerForPrincipalOptions {
  context: ApplicationContext;
  catalog: ProjectCatalog;
  proposals: ChangeProposalService;
  trajectory: ResourceTrajectoryService;
  config: McpConfig;
  observability: Observability;
}

/** What building a server produced. */
export interface McpServerForPrincipal {
  server: McpServer;
  /** The tools this principal's credential can call, in catalog order. */
  visibleTools: readonly McpTool[];
}

/** The `_meta` key carrying cache hints, matching the modern result shape. */
const META_CACHE = "io.modelcontextprotocol/cache";

/** A short freshness hint for cacheable read results. */
const RESOURCE_TTL_MS = 5_000;

/** Whether this credential may call a tool at all. */
function canCall(context: ApplicationContext, tool: McpTool): boolean {
  return tool.requiredPermissions.every((permission) =>
    credentialGrants(context.principal, permission),
  );
}

/**
 * Reject an argument the schema did not declare.
 *
 * The SDK's Zod validation strips unknown keys, which would silently ignore a
 * typo — the opposite of the mission's "reject unknown input". The check is
 * explicit so the refusal is a clear message rather than a mystery.
 */
function assertNoUnknownArguments(
  args: Record<string, unknown>,
  allowed: readonly string[],
  toolName: string,
): void {
  const known = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw invalid(
      `${toolName} does not accept ${unknown.map((key) => `"${key}"`).join(", ")}.`,
      { unknownArguments: unknown },
    );
  }
}

/**
 * Combine the SDK's abort signal with a tool deadline.
 *
 * Returns the signal to hand the application and a disposer the caller must run
 * so the timer does not outlive the call.
 */
function withDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  // A Node timer must not keep the process alive on its own.
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

/** Build the request's MCP server with the tools this principal may call. */
export function createMcpServerForPrincipal(
  options: McpServerForPrincipalOptions,
): McpServerForPrincipal {
  const { context, catalog, proposals, trajectory, config, observability } = options;
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      title: "Software Docs Manager projects",
    },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: MCP_INSTRUCTIONS,
    },
  );

  const allTools = createMcpTools();
  const visibleTools = allTools.filter((tool) => canCall(context, tool));

  // Every tool is *registered*, so a call by name is answered by this server
  // rather than by "unknown tool", and a disabled one is refused rather than
  // silently absent. `tools/list` still omits what the credential can never
  // call — minimum exposure — but the refusal is the boundary, not the listing.
  for (const tool of allTools) {
    const registered = server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema as never,
        annotations: tool.annotations,
      },
      (async (
        args: Record<string, unknown>,
        extra: { signal?: AbortSignal },
      ) => {
        const started = Date.now();
        const { signal, dispose } = withDeadline(
          extra?.signal,
          config.toolTimeoutMs,
        );
        try {
          // The call-time boundary. Disabled tools never reach here through the
          // SDK, but this is the check that would still refuse if they did.
          if (!canCall(context, tool)) {
            throw forbidden(
              `This credential does not carry the ${tool.requiredPermissions.join(", ")} permission required by ${tool.name}.`,
            );
          }
          assertNoUnknownArguments(
            args ?? {},
            Object.keys(tool.inputSchema),
            tool.name,
          );
          const toolContext: ToolContext = {
            context,
             catalog,
             proposals,
             trajectory,
            config,
            signal,
          };
          const outcome = await tool.run(args ?? {}, toolContext);
          observability.logger.log({
            event: "mcp.tool.completed",
            method: "tools/call",
            tool: tool.name,
            durationMs: Date.now() - started,
            actorType: context.principal.actor.kind,
            actorId:
              context.principal.actor.kind === "agent"
                ? context.principal.actor.agentId
                : context.principal.actor.userId,
            subjectUserId: context.principal.subjectUserId,
            requestId: context.requestId,
            result: "success",
          });
          return toolResult(outcome);
        } catch (error) {
          const mapped = toMcpError(error, context.requestId);
          observability.metrics.increment("mcp_tool_errors_total", {
            tool: tool.name,
            outcome: mapped.code,
          });
          observability.logger.log({
            event: "mcp.tool.failed",
            level: mapped.code === "internal" ? "error" : "warn",
            method: "tools/call",
            tool: tool.name,
            durationMs: Date.now() - started,
            actorType: context.principal.actor.kind,
            subjectUserId: context.principal.subjectUserId,
            requestId: context.requestId,
            result: mapped.code,
            message: mapped.message,
          });
          return toolErrorResult(mapped);
        } finally {
          dispose();
        }
      }) as never,
    );
    if (!canCall(context, tool)) registered.disable();
  }

  registerResources(server, { context, catalog, config });

  return { server, visibleTools };
}

/** Wrap a successful tool outcome as an MCP result. */
function toolResult(outcome: {
  text: string;
  structured?: unknown;
}): Record<string, unknown> {
  const result: Record<string, unknown> = {
    content: [{ type: "text", text: outcome.text }],
    isError: false,
  };
  if (outcome.structured !== undefined) {
    result.structuredContent = outcome.structured;
  }
  return result;
}

/** Wrap a failure as a structured tool error the model can act on. */
function toolErrorResult(error: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    content: [{ type: "text", text: describeMcpError(error as never) }],
    structuredContent: { error },
    isError: true,
  };
}

/** The MIME type a resource path's contents carry. */
function mimeTypeOf(path: string): string {
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".eventseq")) return "text/plain";
  if (path.endsWith(".seq")) return "text/plain";
  return "text/plain";
}

/** Read one URI variable, which the SDK may pass as a list. */
function variableOf(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

/**
 * Register the project content as MCP resources (Phase 6 §21–23).
 *
 * A resource read goes through the *same* catalog use case a tool does, so the
 * principal, the project restriction, the membership and the scopes are all
 * enforced. A resource is never a public URL.
 *
 * The `list` callbacks are bounded: a large account produces a page of
 * resources, not thousands.
 */
function registerResources(
  server: McpServer,
  deps: {
    context: ApplicationContext;
    catalog: ProjectCatalog;
    config: McpConfig;
  },
): void {
  const { context, catalog } = deps;
  const cacheMeta = {
    [META_CACHE]: { ttlMs: RESOURCE_TTL_MS, cacheScope: "private" },
  };

  server.registerResource(
    "project",
    new ResourceTemplate("seqdocs://projects/{projectId}", {
      list: async () => {
        const listings = await catalog.listProjects(
          context,
          await catalog.defaultWorkspaceId(context),
        );
        return {
          resources: listings.slice(0, 200).map((entry) => ({
            uri: `seqdocs://projects/${entry.project.id}`,
            name: entry.project.name,
            title: entry.project.name,
            description: `A Software Docs Manager project with ${entry.resourceCount} resources.`,
            mimeType: "application/json",
            _meta: cacheMeta,
          })),
        };
      },
    }),
    {
      title: "Project",
      description: "A project's identity and the caller's access to it.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const projectId = variableOf(variables.projectId);
      const listing = await catalog.getProject(context, projectId);
      const access = await catalog.describeAccess(context, projectId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              project: listing.project,
              role: listing.role,
              resourceCount: listing.resourceCount,
              permissions: access.permissions,
            }),
          },
        ],
      };
    },
  );

  server.registerResource(
    "resource",
    new ResourceTemplate(
      "seqdocs://projects/{projectId}/resources/{resourceId}",
      {
        list: async () => {
          const listings = await catalog.listProjects(
            context,
            await catalog.defaultWorkspaceId(context),
          );
          const resources = [];
          for (const entry of listings.slice(0, 20)) {
            const listed = await catalog.listResources(
              context,
              entry.project.id,
            );
            for (const resource of listed.slice(0, 100)) {
              resources.push({
                uri: `seqdocs://projects/${entry.project.id}/resources/${resource.id}`,
                name: resource.path,
                title: resource.path,
                description: `${resource.path} (revision ${resource.revision})${resource.metadata?.description === undefined ? "" : `: ${resource.metadata.description}`}.`,
                mimeType: mimeTypeOf(resource.path),
                _meta: cacheMeta,
              });
            }
          }
          return { resources: resources.slice(0, 500) };
        },
      },
    ),
    {
      title: "Resource",
      description: "A project resource's text.",
    },
    async (uri, variables) => {
      const projectId = variableOf(variables.projectId);
      const resourceId = variableOf(variables.resourceId);
      const { resource, content } = await catalog.readResource(
        context,
        projectId,
        resourceId,
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: mimeTypeOf(resource.path),
            text: content,
          },
        ],
      };
    },
  );
}
