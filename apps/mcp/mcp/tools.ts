/**
 * The MCP tool catalog (Phase 6 §12–22, §54, §57–61).
 *
 * Every tool is a thin adapter. It validates its arguments, resolves a resource,
 * and calls a use case on the shared {@link ProjectCatalog} — the *same* catalog
 * the HTTP API calls, whose resource mutations go through the one journaled
 * mutation service. No tool touches PostgreSQL, opens a file, or decides whether
 * the caller may act: authorization is `requirePermission` inside the use case.
 *
 * ## Three levels, and why the levels matter
 *
 * - **Discovery** (`list_projects`, `get_project`, `get_project_index`,
 *   `list_resources`, `get_resource_metadata`, `search_project`) is cheap and
 *   bounded. An agent calls these to decide what to do next.
 * - **Primitive resources** (`read_resource`, `create_resource`,
 *   `update_resource`, `move_resource`, `delete_resource`) map almost directly
 *   onto application use cases and are what an agent should fall back to.
 * - **Semantic tools** (`read_diagram`, `upsert_sequence_diagram`,
 *   `render_diagram`, `read_documentation`, `upsert_documentation`,
 *   `get_event_catalog`, `find_event_producers`, `find_event_consumers`,
 *   `validate_project`) are what an agent should *prefer*: they parse, validate,
 *   preserve identity and apply the revision in one idempotent operation.
 *
 * ## No tool explosion
 *
 * There is one `search_project`, not one per resource kind. There is one
 * `get_resource_metadata`, not `get_diagram` plus `get_note`. A tool earns its
 * place by having a distinct intent, a typed schema, a bounded result and a
 * predictable permission.
 *
 * ## What an agent can never send
 *
 * No schema has `absolutePath`, `hostPath`, `rootDirectory` or `shellCommand`.
 * A path is always a project-relative resource path, validated by the storage
 * boundary. `additionalProperties` is denied by the server's strict-argument
 * check, so an unknown field is a refusal rather than a silently ignored key.
 */
import { z } from "zod";
import type { ApplicationContext } from "../../../src/application/context";
import type { Permission } from "../../../src/domain/access/permissions";
import type { ProjectCatalog } from "../../../src/application/project-catalog";
import type { ChangeProposalService } from "../../../src/application/change-proposal-service";
import type { ResourceRecord } from "../../../src/application/ports/project-repository";
import { invalid, notFound } from "../../../src/application/errors";
import { analyze } from "../../../src/language/analyze";
import { diagramTitle } from "../../../src/language/diagram-title";
import { analyzeEventFlow } from "../../../src/language/eventflow/parser";
import {
  eventsOf,
  publicationsOf,
  subscriptionsOf,
} from "../../../src/domain/eventflow/ast";
import { diagramToSvg } from "../../../src/renderer/pipeline/diagram-to-svg";
import { eventFlowSourceToSvg } from "../../../src/renderer/pipeline/eventflow-to-svg";
import { buildProjectIndex } from "../../../src/domain/project/project-index";
import { analyzeResource } from "../../../src/domain/project/resource-analysis";
import { validateProject } from "../../../src/domain/project/validate";
import {
  createEmptyMetadata,
  type ProjectMetadata,
} from "../../../src/domain/workspace/metadata";
import {
  parseSearchQuery,
  searchProject,
  type SearchDocument,
} from "../../../src/domain/search/project-search";
import type { ToolAnnotations } from "../../../src/shared/mcp/protocol";
import type { McpConfig } from "../config";
import { normalizeResourceMetadata } from "../../../src/domain/workspace/resource-metadata";

/** A tool's result before the dispatcher wraps it in an MCP result. */
export interface ToolOutcome {
  text: string;
  structured?: Record<string, unknown>;
}

/** What a tool handler runs against. */
export interface ToolContext {
  context: ApplicationContext;
  catalog: ProjectCatalog;
  proposals: ChangeProposalService;
  config: McpConfig;
  /** Aborted when the client disconnects or the tool deadline elapses. */
  signal?: AbortSignal;
}

/** One entry in the MCP catalog. */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  /** The Zod raw shape the SDK turns into JSON Schema and validates against. */
  inputSchema: Record<string, z.ZodType>;
  annotations: ToolAnnotations;
  /**
   * Every permission the *credential* must carry to call this tool.
   *
   * All are required: an upsert needs both create and update, so a token that
   * could only create cannot use it to overwrite.
   */
  requiredPermissions: readonly Permission[];
  run(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolOutcome>;
}

// ---- Shared schema building blocks -----------------------------------------

/** A project id. */
const projectId = () =>
  z.string().uuid().describe("The project id from list_projects.");

/** A resource reference: an id or a project-relative path. */
const resourceReference = () =>
  z
    .string()
    .min(1)
    .describe(
      'The resource id or its project-relative path (for example "checkout.seq").',
    );

/** A page size. */
const limit = (fallback: number, max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(
      `How many results to return (default ${fallback}, maximum ${max}).`,
    );

/** An opaque pagination cursor from a previous call's `nextCursor`. */
const cursor = () =>
  z
    .string()
    .min(1)
    .optional()
    .describe(
      "The `nextCursor` from the previous page, or omitted for the first.",
    );

/** A retry key that makes a mutation happen at most once. */
const idempotencyKey = () =>
  z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "An optional retry key. Repeating a call with the same key performs the mutation once.",
    );

const resourceMetadata = () =>
  z
    .object({
      description: z
        .string()
        .optional()
        .describe("A short human-readable purpose."),
      tags: z.array(z.string()).optional().describe("Classification labels."),
    })
    .strict()
    .describe("Semantic metadata; send an empty object to clear it.");

/** The read-only annotation set. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** The write annotation set. */
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** The idempotent-write annotation set. */
const UPSERT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** The delete annotation set. */
const DELETE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

// ---- Pagination ------------------------------------------------------------

/** Encode an offset as an opaque cursor. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`v1:${offset}`, "utf8").toString("base64url");
}

/** Decode a cursor, refusing anything that is not one of ours. */
export function decodeCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const match = /^v1:(\d+)$/.exec(decoded);
    if (match === null) throw new Error("shape");
    return Number(match[1]);
  } catch {
    throw invalid(
      "The cursor is not valid. Omit it to start from the beginning.",
    );
  }
}

/** Slice one page out of a list and report the next cursor. */
function page<T>(
  items: readonly T[],
  offset: number,
  size: number,
): { items: T[]; nextCursor: string | null } {
  const slice = items.slice(offset, offset + size);
  const next = offset + slice.length;
  return {
    items: slice,
    nextCursor: next < items.length ? encodeCursor(next) : null,
  };
}

// ---- Argument helpers ------------------------------------------------------

/** Read a string argument the schema already validated. */
function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") {
    throw invalid(`The "${name}" argument is required.`);
  }
  return value;
}

/** Read an optional number argument. */
function numberArg(
  args: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = args[name];
  return typeof value === "number" ? value : undefined;
}

/** Refuse a document larger than its type's ceiling. */
function enforceSize(
  config: McpConfig,
  type: ResourceRecord["type"],
  content: string,
): void {
  const ceiling = config.resourceSizeLimits[type];
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > ceiling) {
    throw invalid(
      `The document is ${bytes} bytes, which exceeds the ${ceiling} byte limit for ${type}.`,
      { kind: "resource_too_large", limit: ceiling, actual: bytes },
    );
  }
}

/** Abort the running tool when the caller has gone away. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw invalid("The request was cancelled before the operation completed.");
  }
}

/** Describe a resource in one line, for tool text output. */
function describeResource(resource: {
  id: string;
  path: string;
  type: string;
  revision: number;
}): string {
  return `- ${resource.path} [${resource.type}] id=${resource.id} revision=${resource.revision}`;
}

function describeProposal(proposal: {
  id: string;
  resourceId: string;
  baseRevision: number;
  title: string;
  status: string;
  version: number;
}): string {
  return `- ${proposal.title} [${proposal.status}] id=${proposal.id} resource=${proposal.resourceId} baseRevision=${proposal.baseRevision} version=${proposal.version}`;
}

/**
 * Resolve an agent-supplied reference to a resource id.
 *
 * A reference is matched as an id first and a path second. The listing that
 * performs the match is itself authorized, so a reference to a resource in
 * another project simply does not resolve — the tool never learns whether it
 * exists.
 */
async function resolveResource(
  toolContext: ToolContext,
  projectIdValue: string,
  reference: string,
): Promise<{ id: string; path: string; type: ResourceRecord["type"] }> {
  const resources = await toolContext.catalog.listResources(
    toolContext.context,
    projectIdValue,
  );

  const match =
    resources.find((resource) => resource.id === reference) ??
    resources.find((resource) => resource.path === reference);
  if (!match) {
    throw notFound(
      `No resource "${reference}" in project ${projectIdValue}. Use list_resources to see the ids and paths that exist.`,
    );
  }
  return match;
}

/** The metadata document a project's identity implies, for indexing. */
function metadataFrom(
  resources: ReadonlyArray<{
    id: string;
    path: string;
    type: ResourceRecord["type"];
  }>,
): ProjectMetadata {
  const metadata = createEmptyMetadata();
  return {
    ...metadata,
    resources: resources.map((resource) => ({
      id: resource.id,
      path: resource.path,
      type: resource.type,
    })),
  };
}

/** The search documents for a project, reading each resource's text. */
async function searchDocuments(
  toolContext: ToolContext,
  projectIdValue: string,
  projectName: string,
  maxDocuments: number,
): Promise<SearchDocument[]> {
  const resources = await toolContext.catalog.listResources(
    toolContext.context,
    projectIdValue,
  );
  const documents: SearchDocument[] = [];
  for (const resource of resources.slice(0, maxDocuments)) {
    throwIfAborted(toolContext.signal);
    const { content } = await toolContext.catalog.readResource(
      toolContext.context,
      projectIdValue,
      resource.id,
    );
    documents.push({
      kind: resource.type === "markdown-document" ? "note" : "diagram",
      id: resource.id,
      projectId: projectIdValue,
      projectName,
      name: resource.path,
      title: resource.path,
      content,
      metadata: resource.metadata,
    });
  }
  return documents;
}

// ---- The catalog -----------------------------------------------------------

/** How many documents one search or validation call will read. */
const MAX_INDEXED_DOCUMENTS = 500;

/** Build every tool the MCP service exposes. */
export function createMcpTools(): McpTool[] {
  return [
    // ---- Level 0: bootstrap -------------------------------------------------

    {
      name: "create_project",
      title: "Create a project",
      description:
        "Create a server project owned by this credential's user. Use this when list_projects is empty; the resulting project is immediately available to this credential.",
      inputSchema: {
        name: z.string().min(1).describe("The new project's name."),
      },
      annotations: { ...WRITE, title: "Create a project" },
      requiredPermissions: ["project:create"],
      async run(args, toolContext) {
        const listing = await toolContext.catalog.createProject(
          toolContext.context,
          {
            name: stringArg(args, "name"),
            workspaceId: await toolContext.catalog.defaultWorkspaceId(
              toolContext.context,
            ),
          },
        );
        return {
          text: `Created project "${listing.project.name}" (id: ${listing.project.id}).`,
          structured: {
            project: {
              id: listing.project.id,
              name: listing.project.name,
              slug: listing.project.slug,
              ownerId: listing.project.ownerId,
              resourceCount: listing.resourceCount,
            },
            role: listing.role,
          },
        };
      },
    },

    // ---- Level 1: discovery ------------------------------------------------

    {
      name: "list_projects",
      title: "List projects",
      description:
        "List every server project this token can see, with the caller's role and resource count. Call this first: the project ids it returns are what every other tool addresses.",
      inputSchema: {},
      annotations: { ...READ_ONLY, title: "List projects" },
      requiredPermissions: ["project:read"],
      async run(_args, toolContext) {
        const listings = await toolContext.catalog.listProjects(
          toolContext.context,
          await toolContext.catalog.defaultWorkspaceId(toolContext.context),
        );
        const text =
          listings.length === 0
            ? "This account has no projects."
            : listings
                .map(
                  (entry) =>
                    `- ${entry.project.name} (id: ${entry.project.id}, role: ${entry.role}, ${entry.resourceCount} resources)`,
                )
                .join("\n");
        return {
          text,
          structured: {
            projects: listings.map((entry) => ({
              id: entry.project.id,
              name: entry.project.name,
              slug: entry.project.slug,
              role: entry.role,
              resourceCount: entry.resourceCount,
            })),
          },
        };
      },
    },

    {
      name: "get_project",
      title: "Get a project",
      description:
        "Read one project's identity and what this token may do in it (`role` and the granted `permissions`). Use it to check whether a write is possible before attempting one.",
      inputSchema: { projectId: projectId() },
      annotations: { ...READ_ONLY, title: "Get a project" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const listing = await toolContext.catalog.getProject(
          toolContext.context,
          id,
        );
        const access = await toolContext.catalog.describeAccess(
          toolContext.context,
          id,
        );
        return {
          text: `Project "${listing.project.name}" (id: ${listing.project.id}, role: ${listing.role}, ${listing.resourceCount} resources). Permissions: ${access.permissions.join(", ") || "none"}.`,
          structured: {
            project: {
              id: listing.project.id,
              name: listing.project.name,
              slug: listing.project.slug,
              ownerId: listing.project.ownerId,
              resourceCount: listing.resourceCount,
            },
            access,
          },
        };
      },
    },

    {
      name: "get_project_index",
      title: "Get the project index",
      description:
        "Return a bounded index of a project: every resource with its id, path and type, plus the sequence diagrams' participant and message counts. Use it to understand a project before reading individual documents.",
      inputSchema: {
        projectId: projectId(),
        limit: limit(100, 500),
        cursor: cursor(),
      },
      annotations: { ...READ_ONLY, title: "Get the project index" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resources = await toolContext.catalog.listResources(
          toolContext.context,
          id,
        );
        const { items, nextCursor } = page(
          resources,
          decodeCursor(
            typeof args.cursor === "string" ? args.cursor : undefined,
          ),
          numberArg(args, "limit") ?? 100,
        );
        return {
          text: `${resources.length} resources; showing ${items.length}.`,
          structured: {
            projectId: id,
            total: resources.length,
            resources: items.map((resource) => ({
              id: resource.id,
              path: resource.path,
              type: resource.type,
              revision: resource.revision,
              ...(resource.metadata === undefined
                ? {}
                : { metadata: resource.metadata }),
            })),
            nextCursor,
          },
        };
      },
    },

    {
      name: "list_resources",
      title: "List resources",
      description:
        "List a project's resources with stable identity, semantic metadata and current revision. The revision is what a write must present as `expectedRevision`. Paginated.",
      inputSchema: {
        projectId: projectId(),
        limit: limit(100, 500),
        cursor: cursor(),
        type: z
          .enum(["sequence-diagram", "event-flow", "markdown-document"])
          .optional()
          .describe("Only list resources of this kind."),
      },
      annotations: { ...READ_ONLY, title: "List resources" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const wanted = args.type;
        const all = await toolContext.catalog.listResources(
          toolContext.context,
          id,
        );
        const filtered =
          typeof wanted === "string"
            ? all.filter((resource) => resource.type === wanted)
            : all;
        const { items, nextCursor } = page(
          filtered,
          decodeCursor(
            typeof args.cursor === "string" ? args.cursor : undefined,
          ),
          numberArg(args, "limit") ?? 100,
        );
        return {
          text:
            items.length === 0
              ? `Project ${id} has no matching resources.`
              : items.map(describeResource).join("\n"),
          structured: {
            projectId: id,
            total: filtered.length,
            resources: items,
            nextCursor,
          },
        };
      },
    },

    {
      name: "list_change_proposals",
      title: "List change proposals",
      description: "List isolated change proposals for a resource.",
      inputSchema: { projectId: projectId(), resource: resourceReference() },
      annotations: { ...READ_ONLY, title: "List change proposals" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const project = stringArg(args, "projectId");
        const resource = await resolveResource(
          toolContext,
          project,
          stringArg(args, "resource"),
        );
        const proposals = await toolContext.proposals.list(
          toolContext.context,
          project,
          resource.id,
        );
        return {
          text:
            proposals.map(describeProposal).join("\n") ||
            "No change proposals.",
          structured: { proposals },
        };
      },
    },

    {
      name: "create_change_proposal",
      title: "Create change proposal",
      description:
        "Create a draft proposal initialized from an immutable resource revision.",
      inputSchema: {
        projectId: projectId(),
        resource: resourceReference(),
        title: z.string().min(1),
        description: z.string().optional(),
        baseRevision: z.number().int().min(1).optional(),
      },
      annotations: { ...WRITE, title: "Create change proposal" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const project = stringArg(args, "projectId");
        const resource = await resolveResource(
          toolContext,
          project,
          stringArg(args, "resource"),
        );
        const proposal = await toolContext.proposals.create(
          toolContext.context,
          project,
          resource.id,
          {
            title: stringArg(args, "title"),
            ...(typeof args.description === "string"
              ? { description: args.description }
              : {}),
            ...(typeof args.baseRevision === "number"
              ? { baseRevision: args.baseRevision }
              : {}),
          },
        );
        return { text: describeProposal(proposal), structured: { proposal } };
      },
    },

    {
      name: "get_change_proposal",
      title: "Get change proposal",
      description:
        "Read a proposal's isolated content, metadata, status and provenance.",
      inputSchema: { proposalId: z.string().uuid() },
      annotations: { ...READ_ONLY, title: "Get change proposal" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const proposal = await toolContext.proposals.get(
          toolContext.context,
          stringArg(args, "proposalId"),
        );
        return { text: describeProposal(proposal), structured: { proposal } };
      },
    },

    {
      name: "get_change_proposal_diff",
      title: "Get change proposal diff",
      description:
        "Compare a proposal's immutable base revision with its candidate state. Returns structured semantic changes, metadata changes, bounded source hunks, diagnostics, and separate canonical staleness information. This is read-only and does not detect conflicts or merge.",
      inputSchema: { proposalId: z.string().uuid() },
      annotations: { ...READ_ONLY, title: "Get change proposal diff" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const diff = await toolContext.proposals.diff(
          toolContext.context,
          stringArg(args, "proposalId"),
        );
        return {
          text: `${diff.summary.semanticChanges} semantic changes; ${diff.summary.sourceHunks} source hunks. Base revision ${diff.baseRevision}, current revision ${diff.currentRevision}${diff.stale ? " (stale)" : ""}.`,
          structured: { ...diff },
        };
      },
    },

    {
      name: "update_change_proposal",
      title: "Update change proposal",
      description:
        "Edit a draft or open proposal using its proposal-local version.",
      inputSchema: {
        proposalId: z.string().uuid(),
        expectedVersion: z.number().int().min(1),
        proposedContent: z.string().optional(),
        proposedMetadata: resourceMetadata().optional(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
      },
      annotations: { ...WRITE, title: "Update change proposal" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const proposal = await toolContext.proposals.update(
          toolContext.context,
          stringArg(args, "proposalId"),
          {
            expectedVersion: numberArg(args, "expectedVersion") ?? 0,
            ...(typeof args.proposedContent === "string"
              ? { proposedContent: args.proposedContent }
              : {}),
            ...(args.proposedMetadata === undefined
              ? {}
              : {
                  proposedMetadata: normalizeResourceMetadata(
                    args.proposedMetadata as {
                      description?: string;
                      tags?: string[];
                    },
                  ),
                }),
            ...(typeof args.title === "string" ? { title: args.title } : {}),
            ...(typeof args.description === "string"
              ? { description: args.description }
              : {}),
          },
        );
        return { text: describeProposal(proposal), structured: { proposal } };
      },
    },

    {
      name: "open_change_proposal",
      title: "Open change proposal",
      description:
        "Move a draft proposal to open using its proposal-local version.",
      inputSchema: {
        proposalId: z.string().uuid(),
        expectedVersion: z.number().int().min(1),
      },
      annotations: { ...WRITE, title: "Open change proposal" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const proposal = await toolContext.proposals.open(
          toolContext.context,
          stringArg(args, "proposalId"),
          numberArg(args, "expectedVersion") ?? 0,
        );
        return { text: describeProposal(proposal), structured: { proposal } };
      },
    },

    {
      name: "close_change_proposal",
      title: "Close change proposal",
      description:
        "Close a draft or open proposal using its proposal-local version.",
      inputSchema: {
        proposalId: z.string().uuid(),
        expectedVersion: z.number().int().min(1),
      },
      annotations: { ...WRITE, title: "Close change proposal" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const proposal = await toolContext.proposals.close(
          toolContext.context,
          stringArg(args, "proposalId"),
          numberArg(args, "expectedVersion") ?? 0,
        );
        return { text: describeProposal(proposal), structured: { proposal } };
      },
    },

    {
      name: "get_resource_metadata",
      title: "Get resource metadata",
      description:
        "Read one resource's identity, path, type, semantic metadata and current revision without its contents.",
      inputSchema: { projectId: projectId(), resource: resourceReference() },
      annotations: { ...READ_ONLY, title: "Get resource metadata" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
        );
        const resource = await toolContext.catalog.getResource(
          toolContext.context,
          id,
          resolved.id,
        );
        return {
          text: describeResource(resource),
          structured: { resource },
        };
      },
    },

    {
      name: "update_resource_metadata",
      title: "Update resource metadata",
      description:
        "Replace a resource's semantic description and tags without changing its text. Send the revision you read; an empty metadata object clears both fields. Retries can use an idempotency key.",
      inputSchema: {
        projectId: projectId(),
        resource: resourceReference(),
        metadata: resourceMetadata(),
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .describe("The revision you last read."),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...UPSERT, title: "Update resource metadata" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
        );
        const current = await toolContext.catalog.readResource(
          toolContext.context,
          id,
          resolved.id,
        );
        const resource = await toolContext.catalog.updateResource(
          toolContext.context,
          id,
          resolved.id,
          {
            content: current.content,
            metadata: normalizeResourceMetadata(
              args.metadata as { description?: string; tags?: string[] },
            ),
            expectedRevision: numberArg(args, "expectedRevision") ?? 0,
            ...(typeof args.idempotencyKey === "string"
              ? { idempotencyKey: args.idempotencyKey }
              : {}),
          },
        );
        return {
          text: `Updated metadata for ${resource.path}; it is now at revision ${resource.revision}.`,
          structured: { resource },
        };
      },
    },

    {
      name: "search_project",
      title: "Search a project",
      description:
        "Search a project's documents and metadata with bounded snippets — never whole files. Supports plain text plus `tag:payments`, `type:diagram`, and the existing project/kind/participant filters. Paginated.",
      inputSchema: {
        projectId: projectId(),
        query: z
          .string()
          .describe(
            "Plain text or filters such as `tag:payments`, `type:diagram`, `kind:note`, `project:name`, and `participant:Name`.",
          ),
        limit: limit(50, 200),
        cursor: cursor(),
      },
      annotations: { ...READ_ONLY, title: "Search a project" },
      requiredPermissions: ["project:search"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const offset = decodeCursor(
          typeof args.cursor === "string" ? args.cursor : undefined,
        );
        const size = numberArg(args, "limit") ?? 50;
        const listing = await toolContext.catalog.getProject(
          toolContext.context,
          id,
        );
        const documents = await searchDocuments(
          toolContext,
          id,
          listing.project.name,
          MAX_INDEXED_DOCUMENTS,
        );
        const matches = searchProject(
          documents,
          parseSearchQuery(stringArg(args, "query")),
          { limit: offset + size },
        );
        const { items, nextCursor } = page(matches, offset, size);
        return {
          text:
            items.length === 0
              ? "No matches."
              : items
                  .map(
                    (match) =>
                      `- ${match.name}:${match.line} — ${match.excerpt}`,
                  )
                  .join("\n"),
          structured: {
            results: items.map((match) => ({
              resourceId: match.id,
              path: match.name,
              line: match.line,
              column: match.column,
              snippet: match.excerpt,
              description: match.metadata?.description,
              tags: match.metadata?.tags,
              matchedFields: match.matchedFields,
            })),
            nextCursor,
          },
        };
      },
    },

    // ---- Level 2: primitive resource operations ----------------------------

    {
      name: "read_resource",
      title: "Read a resource",
      description:
        "Read one resource's full text together with its identity and current revision. Always read before updating, so you hold the revision the write must present.",
      inputSchema: { projectId: projectId(), resource: resourceReference() },
      annotations: { ...READ_ONLY, title: "Read a resource" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
        );
        const { resource, content } = await toolContext.catalog.readResource(
          toolContext.context,
          id,
          resolved.id,
        );
        return {
          text: `${resource.path} [${resource.type}] id=${resource.id} revision=${resource.revision}\n\n${content}`,
          structured: { resource, content },
        };
      },
    },

    {
      name: "create_resource",
      title: "Create a resource",
      description:
        "Create a new document at a project-relative path. Fails if something already exists there: to change an existing document, read it and call update_resource with its revision. Send an `idempotencyKey` to make a retry safe.",
      inputSchema: {
        projectId: projectId(),
        path: z
          .string()
          .min(1)
          .describe(
            'The project-relative path, for example "checkout.seq" or "notes/overview.md". No absolute paths and no "..".',
          ),
        type: z
          .enum(["sequence-diagram", "event-flow", "markdown-document"])
          .describe("What is being created."),
        content: z.string().describe("The full text of the new resource."),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...WRITE, title: "Create a resource" },
      requiredPermissions: ["resource:create"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const type = args.type as ResourceRecord["type"];
        const content = typeof args.content === "string" ? args.content : "";
        enforceSize(toolContext.config, type, content);
        const resource = await toolContext.catalog.createResource(
          toolContext.context,
          id,
          {
            path: stringArg(args, "path"),
            type,
            content,
            ...(typeof args.idempotencyKey === "string"
              ? { idempotencyKey: args.idempotencyKey }
              : {}),
          },
        );
        return {
          text: `Created ${resource.path} (id: ${resource.id}, revision: ${resource.revision}).`,
          structured: { resource },
        };
      },
    },

    {
      name: "update_resource",
      title: "Update a resource",
      description:
        "Replace a resource's text. `expectedRevision` must be the revision you last read: a stale value is refused with a conflict instead of overwriting a concurrent edit. On conflict, re-read and retry. Send an `idempotencyKey` to make a retry safe.",
      inputSchema: {
        projectId: projectId(),
        resource: resourceReference(),
        content: z.string().describe("The complete new text."),
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .describe(
            "The revision you last read, from read_resource or get_resource_metadata.",
          ),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...WRITE, title: "Update a resource" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
        );
        const content = typeof args.content === "string" ? args.content : "";
        enforceSize(toolContext.config, resolved.type, content);
        const resource = await toolContext.catalog.updateResource(
          toolContext.context,
          id,
          resolved.id,
          {
            content,
            expectedRevision: numberArg(args, "expectedRevision") ?? 0,
            ...(typeof args.idempotencyKey === "string"
              ? { idempotencyKey: args.idempotencyKey }
              : {}),
          },
        );
        return {
          text: `Updated ${resource.path}; it is now at revision ${resource.revision}.`,
          structured: { resource },
        };
      },
    },

    {
      name: "move_resource",
      title: "Move or rename a resource",
      description:
        "Move a resource to another project-relative path, keeping its id and revision history. `expectedRevision` is required and a stale value is refused with a conflict.",
      inputSchema: {
        projectId: projectId(),
        resource: resourceReference(),
        path: z.string().min(1).describe("The new project-relative path."),
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .describe("The revision you last read."),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...WRITE, title: "Move or rename a resource" },
      requiredPermissions: ["resource:move"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
        );
        const resource = await toolContext.catalog.moveResource(
          toolContext.context,
          id,
          resolved.id,
          {
            path: stringArg(args, "path"),
            expectedRevision: numberArg(args, "expectedRevision") ?? 0,
            ...(typeof args.idempotencyKey === "string"
              ? { idempotencyKey: args.idempotencyKey }
              : {}),
          },
        );
        return {
          text: `Moved to ${resource.path}; it is now at revision ${resource.revision}.`,
          structured: { resource },
        };
      },
    },

    {
      name: "delete_resource",
      title: "Delete a resource",
      description:
        "Delete a resource permanently. Requires `confirm: true`; without it the call fails and explains what would be removed, so an accidental invocation cannot destroy work.",
      inputSchema: {
        projectId: projectId(),
        resource: resourceReference(),
        confirm: z.boolean().describe("Must be true to actually delete."),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...DELETE, title: "Delete a resource" },
      requiredPermissions: ["resource:delete"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
        );
        const resource = await toolContext.catalog.getResource(
          toolContext.context,
          id,
          resolved.id,
        );
        if (args.confirm !== true) {
          throw invalid(
            `Refusing to delete "${resource.path}" without confirmation. Call delete_resource again with confirm: true.`,
          );
        }
        await toolContext.catalog.deleteResource(
          toolContext.context,
          id,
          resolved.id,
          {
            ...(typeof args.idempotencyKey === "string"
              ? { idempotencyKey: args.idempotencyKey }
              : {}),
          },
        );
        return {
          text: `Deleted ${resource.path} (id: ${resource.id}).`,
          structured: { deleted: resource },
        };
      },
    },

    // ---- Level 3: semantic tools ------------------------------------------

    {
      name: "read_diagram",
      title: "Read a sequence diagram",
      description:
        "Read a sequence diagram and return its title, lifelines, message count and any syntax or semantic problems, without making you parse the DSL. Prefer this over read_resource when you want to understand a diagram.",
      inputSchema: { projectId: projectId(), resource: resourceReference() },
      annotations: { ...READ_ONLY, title: "Read a sequence diagram" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
        );
        if (resolved.type !== "sequence-diagram") {
          throw invalid(`"${resolved.path}" is not a sequence diagram.`);
        }
        const { resource, content } = await toolContext.catalog.readResource(
          toolContext.context,
          id,
          resolved.id,
        );
        const { ast, diagnostics } = analyze(content);
        return {
          text: `${resource.path} — title "${diagramTitle(content) ?? "(none)"}", ${ast?.participants.length ?? 0} lifelines, ${diagnostics.length} diagnostics.`,
          structured: {
            resource,
            title: diagramTitle(content) ?? null,
            participants: (ast?.participants ?? []).map((p) => p.id),
            statements: ast?.statements.length ?? 0,
            diagnostics: diagnostics.map((diagnostic) => ({
              severity: diagnostic.severity,
              message: diagnostic.message,
              code: String(diagnostic.code),
            })),
            content,
          },
        };
      },
    },

    {
      name: "upsert_sequence_diagram",
      title: "Create or replace a sequence diagram",
      description:
        "Create a diagram at `path`, or replace the one already there when `expectedRevision` matches. The text is parsed and validated first: invalid DSL is never written, and the problems are returned instead. Prefer this over create_resource/update_resource for agent workflows; it is idempotent, so a retry is safe.",
      inputSchema: {
        projectId: projectId(),
        path: z
          .string()
          .min(1)
          .describe('Project-relative path, for example "checkout.seq".'),
        content: z.string().describe("The complete DSL text."),
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "The revision you last read. Required when the document already exists.",
          ),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...UPSERT, title: "Upsert a sequence diagram" },
      requiredPermissions: ["resource:create", "resource:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const path = stringArg(args, "path");
        const content = typeof args.content === "string" ? args.content : "";
        enforceSize(toolContext.config, "sequence-diagram", content);
        const { diagnostics } = analyze(content);
        const errors = diagnostics.filter(
          (diagnostic) => diagnostic.severity === "error",
        );
        if (errors.length > 0) {
          throw invalid(
            `The diagram was not written: ${errors.length} error(s).\n${errors
              .map((diagnostic) => `- ${diagnostic.message}`)
              .join("\n")}`,
            {
              kind: "validation_failed",
              diagnostics: errors.map((diagnostic) => ({
                message: diagnostic.message,
                code: String(diagnostic.code),
              })),
            },
          );
        }
        return upsertByPath(toolContext, {
          projectId: id,
          path,
          type: "sequence-diagram",
          content,
          ...(numberArg(args, "expectedRevision") === undefined
            ? {}
            : { expectedRevision: numberArg(args, "expectedRevision") }),
          ...(typeof args.idempotencyKey === "string"
            ? { idempotencyKey: args.idempotencyKey }
            : {}),
        });
      },
    },

    {
      name: "upsert_event_flow",
      title: "Create or replace an event flow",
      description:
        "Create or replace an event-flow document. Like upsert_sequence_diagram, the text is validated before it is persisted and the operation is idempotent.",
      inputSchema: {
        projectId: projectId(),
        path: z
          .string()
          .min(1)
          .describe('Project-relative path, for example "payments.eventseq".'),
        content: z.string().describe("The complete event-flow text."),
        expectedRevision: z.number().int().min(1).optional(),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...UPSERT, title: "Upsert an event flow" },
      requiredPermissions: ["resource:create", "resource:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const path = stringArg(args, "path");
        const content = typeof args.content === "string" ? args.content : "";
        enforceSize(toolContext.config, "event-flow", content);
        const { diagnostics } = analyzeEventFlow(content);
        const errors = diagnostics.filter(
          (diagnostic) => diagnostic.severity === "error",
        );
        if (errors.length > 0) {
          throw invalid(
            `The event flow was not written: ${errors.length} error(s).\n${errors
              .map((diagnostic) => `- ${diagnostic.message}`)
              .join("\n")}`,
            { kind: "validation_failed" },
          );
        }
        return upsertByPath(toolContext, {
          projectId: id,
          path,
          type: "event-flow",
          content,
          ...(numberArg(args, "expectedRevision") === undefined
            ? {}
            : { expectedRevision: numberArg(args, "expectedRevision") }),
          ...(typeof args.idempotencyKey === "string"
            ? { idempotencyKey: args.idempotencyKey }
            : {}),
        });
      },
    },

    {
      name: "render_diagram",
      title: "Render a diagram to SVG",
      description:
        "Render a stored sequence diagram or event flow to an SVG document string. Bounded by the render deadline; prefer this over asking for the SVG through a browser.",
      inputSchema: {
        projectId: projectId(),
        resource: resourceReference(),
      },
      annotations: { ...READ_ONLY, title: "Render a diagram" },
      requiredPermissions: ["diagram:render"],
      async run(args, toolContext) {
        throwIfAborted(toolContext.signal);
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
        );
        const { resource, content } = await toolContext.catalog.readResource(
          toolContext.context,
          id,
          resolved.id,
        );
        throwIfAborted(toolContext.signal);
        const svg =
          resource.type === "event-flow"
            ? eventFlowSourceToSvg(content)
            : diagramToSvg(content);
        return {
          text: `Rendered ${resource.path} (${svg.length} bytes of SVG).`,
          structured: { resource, svg },
        };
      },
    },

    {
      name: "read_documentation",
      title: "Read a markdown document",
      description:
        "Read a markdown document's text and its heading outline. Prefer this over read_resource for documentation, because it also reports the structure.",
      inputSchema: { projectId: projectId(), resource: resourceReference() },
      annotations: { ...READ_ONLY, title: "Read documentation" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
        );
        if (resolved.type !== "markdown-document") {
          throw invalid(`"${resolved.path}" is not a markdown document.`);
        }
        const { resource, content } = await toolContext.catalog.readResource(
          toolContext.context,
          id,
          resolved.id,
        );
        const headings = content
          .split("\n")
          .filter((line) => /^#{1,6}\s+\S/.test(line))
          .map((line) => line.trim());
        return {
          text: `${resource.path} — ${headings.length} heading(s).`,
          structured: { resource, headings, content },
        };
      },
    },

    {
      name: "upsert_documentation",
      title: "Create or replace a markdown document",
      description:
        "Create or replace a markdown document at `path`. When the document already exists, `expectedRevision` is required and must be the revision you last read. Idempotent, so a retry with the same key is safe.",
      inputSchema: {
        projectId: projectId(),
        path: z
          .string()
          .min(1)
          .describe('Project-relative path, for example "docs/overview.md".'),
        content: z.string().describe("The complete markdown text."),
        expectedRevision: z.number().int().min(1).optional(),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...UPSERT, title: "Upsert documentation" },
      requiredPermissions: ["resource:create", "resource:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const path = stringArg(args, "path");
        const content = typeof args.content === "string" ? args.content : "";
        enforceSize(toolContext.config, "markdown-document", content);
        return upsertByPath(toolContext, {
          projectId: id,
          path,
          type: "markdown-document",
          content,
          ...(numberArg(args, "expectedRevision") === undefined
            ? {}
            : { expectedRevision: numberArg(args, "expectedRevision") }),
          ...(typeof args.idempotencyKey === "string"
            ? { idempotencyKey: args.idempotencyKey }
            : {}),
        });
      },
    },

    {
      name: "get_event_catalog",
      title: "Get the event catalog",
      description:
        "List the events a project declares and, for each, the services that publish and subscribe to it. Paginated and bounded.",
      inputSchema: {
        projectId: projectId(),
        limit: limit(100, 500),
        cursor: cursor(),
      },
      annotations: { ...READ_ONLY, title: "Get the event catalog" },
      requiredPermissions: ["project:search"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const entries = await eventCatalog(toolContext, id);
        const { items, nextCursor } = page(
          entries,
          decodeCursor(
            typeof args.cursor === "string" ? args.cursor : undefined,
          ),
          numberArg(args, "limit") ?? 100,
        );
        return {
          text:
            items.length === 0
              ? "This project declares no events."
              : items
                  .map(
                    (entry) =>
                      `- ${entry.name} (declared in ${entry.declaredIn})`,
                  )
                  .join("\n"),
          structured: { events: items, nextCursor },
        };
      },
    },

    {
      name: "find_event_producers",
      title: "Find event producers",
      description:
        "Find the services that publish a given event, across the project's event flows.",
      inputSchema: {
        projectId: projectId(),
        event: z.string().min(1).describe("The event name to look for."),
      },
      annotations: { ...READ_ONLY, title: "Find event producers" },
      requiredPermissions: ["project:search"],
      async run(args, toolContext) {
        return findEventSides(
          toolContext,
          stringArg(args, "projectId"),
          stringArg(args, "event"),
          "producers",
        );
      },
    },

    {
      name: "find_event_consumers",
      title: "Find event consumers",
      description:
        "Find the services that subscribe to a given event, across the project's event flows.",
      inputSchema: {
        projectId: projectId(),
        event: z.string().min(1).describe("The event name to look for."),
      },
      annotations: { ...READ_ONLY, title: "Find event consumers" },
      requiredPermissions: ["project:search"],
      async run(args, toolContext) {
        return findEventSides(
          toolContext,
          stringArg(args, "projectId"),
          stringArg(args, "event"),
          "consumers",
        );
      },
    },

    {
      name: "validate_project",
      title: "Validate a project",
      description:
        "Run the project's own validators across every resource and return the diagnostics with their severity, file and location. Bounded to the first 500 documents and a page of problems.",
      inputSchema: {
        projectId: projectId(),
        severity: z
          .enum(["error", "warning", "info"])
          .optional()
          .describe("Only return diagnostics of this severity."),
        limit: limit(100, 500),
        cursor: cursor(),
      },
      annotations: { ...READ_ONLY, title: "Validate a project" },
      requiredPermissions: ["project:validate"],
      async run(args, toolContext) {
        throwIfAborted(toolContext.signal);
        const id = stringArg(args, "projectId");
        const resources = await toolContext.catalog.listResources(
          toolContext.context,
          id,
        );
        const metadata = metadataFrom(resources);
        const analyses = [];
        for (const resource of resources.slice(0, MAX_INDEXED_DOCUMENTS)) {
          throwIfAborted(toolContext.signal);
          const { content } = await toolContext.catalog.readResource(
            toolContext.context,
            id,
            resource.id,
          );
          analyses.push(
            analyzeResource(
              {
                id: resource.id,
                projectId: id,
                path: resource.path,
                type: resource.type,
                title: resource.path,
              },
              content,
            ),
          );
        }
        const perResource = analyses.flatMap(
          (analysis) => analysis.diagnostics,
        );
        const index = buildProjectIndex(id, analyses, metadata, (core) =>
          validateProject(core, perResource, metadata),
        );
        const wanted = args.severity;
        const filtered =
          typeof wanted === "string"
            ? index.diagnostics.filter(
                (diagnostic) => diagnostic.severity === wanted,
              )
            : index.diagnostics;
        const { items, nextCursor } = page(
          filtered,
          decodeCursor(
            typeof args.cursor === "string" ? args.cursor : undefined,
          ),
          numberArg(args, "limit") ?? 100,
        );
        return {
          text:
            items.length === 0
              ? "No problems found."
              : items
                  .map(
                    (diagnostic) =>
                      `- [${diagnostic.severity}] ${diagnostic.message}`,
                  )
                  .join("\n"),
          structured: {
            projectId: id,
            total: filtered.length,
            diagnostics: items.map((diagnostic) => ({
              severity: diagnostic.severity,
              message: diagnostic.message,
              code: String(diagnostic.code),
            })),
            nextCursor,
          },
        };
      },
    },
  ];
}

// ---- Semantic helpers ------------------------------------------------------

/** One event and where it was declared. */
interface EventCatalogEntry {
  name: string;
  declaredIn: string;
}

/** Every event a project's event flows declare. */
async function eventCatalog(
  toolContext: ToolContext,
  projectIdValue: string,
): Promise<EventCatalogEntry[]> {
  const resources = await toolContext.catalog.listResources(
    toolContext.context,
    projectIdValue,
  );
  const entries: EventCatalogEntry[] = [];
  for (const resource of resources) {
    if (resource.type !== "event-flow") continue;
    throwIfAborted(toolContext.signal);
    const { content } = await toolContext.catalog.readResource(
      toolContext.context,
      projectIdValue,
      resource.id,
    );
    const { flow } = analyzeEventFlow(content);
    for (const event of eventsOf(flow)) {
      entries.push({ name: event.name, declaredIn: resource.path });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/** Find the services that publish or consume an event. */
async function findEventSides(
  toolContext: ToolContext,
  projectIdValue: string,
  eventName: string,
  side: "producers" | "consumers",
): Promise<ToolOutcome> {
  const resources = await toolContext.catalog.listResources(
    toolContext.context,
    projectIdValue,
  );
  const hits: Array<{ service: string; resource: string }> = [];
  for (const resource of resources) {
    if (resource.type !== "event-flow") continue;
    throwIfAborted(toolContext.signal);
    const { content } = await toolContext.catalog.readResource(
      toolContext.context,
      projectIdValue,
      resource.id,
    );
    const { flow } = analyzeEventFlow(content);
    const edges =
      side === "producers"
        ? publicationsOf(flow).filter((edge) => edge.event === eventName)
        : subscriptionsOf(flow).filter((edge) => edge.event === eventName);
    for (const edge of edges) {
      const service =
        "service" in edge && typeof edge.service === "string"
          ? edge.service
          : "(unknown)";
      hits.push({ service, resource: resource.path });
    }
  }
  return {
    text:
      hits.length === 0
        ? `No ${side} found for "${eventName}".`
        : hits.map((hit) => `- ${hit.service} (${hit.resource})`).join("\n"),
    structured: { event: eventName, [side]: hits },
  };
}

/** Create or replace a document by path, with the revision contract enforced. */
async function upsertByPath(
  toolContext: ToolContext,
  input: {
    projectId: string;
    path: string;
    type: ResourceRecord["type"];
    content: string;
    expectedRevision?: number;
    idempotencyKey?: string;
  },
): Promise<ToolOutcome> {
  const resources = await toolContext.catalog.listResources(
    toolContext.context,
    input.projectId,
  );
  const existing = resources.find((resource) => resource.path === input.path);
  if (existing === undefined) {
    const resource = await toolContext.catalog.createResource(
      toolContext.context,
      input.projectId,
      {
        path: input.path,
        type: input.type,
        content: input.content,
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: input.idempotencyKey }),
      },
    );
    return {
      text: `Created ${resource.path} at revision ${resource.revision}.`,
      structured: { created: true, resource },
    };
  }
  if (input.expectedRevision === undefined) {
    throw invalid(
      `"${input.path}" already exists at revision ${existing.revision}. Read it, then call again with expectedRevision: ${existing.revision}.`,
      { currentRevision: existing.revision, path: input.path },
    );
  }
  const resource = await toolContext.catalog.updateResource(
    toolContext.context,
    input.projectId,
    existing.id,
    {
      content: input.content,
      expectedRevision: input.expectedRevision,
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
    },
  );
  return {
    text: `Replaced ${resource.path}; it is now at revision ${resource.revision}.`,
    structured: { created: false, resource },
  };
}

/** Re-exported so the server can name the type it builds. */
export type { ResourceRecord };
