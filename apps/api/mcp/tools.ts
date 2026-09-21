/**
 * The remote MCP tool catalog (Phase 5).
 *
 * Every tool here is a thin adapter: it validates arguments, addresses a use
 * case on the shared {@link ProjectCatalog}, and renders the answer for a model.
 * No tool implements a project operation, touches the database, or reads a file
 * — the catalog the HTTP routes call is the same catalog these tools call, so
 * the remote agent and the browser cannot disagree about what a resource is or
 * what its revision means.
 *
 * Two conventions are inherited deliberately from the local stdio MCP server,
 * because an agent that knows one should know the other:
 *
 * - a read tool is annotated `readOnlyHint: true`, so a client that only
 *   auto-approves read-only tools still works;
 * - a tool failure is *data* (a message the model can act on), not a JSON-RPC
 *   protocol error.
 *
 * The write tools require `expectedRevision` — the revision the caller last
 * read. That is not a convenience: without it a write would silently overwrite
 * whoever wrote first, which is exactly the last-write-wins path the mission
 * forbids. The catalog's conditional update is the authority; the tool only
 * refuses to send a write that did not name a revision.
 */
import type { ApplicationContext } from "../../../src/application/context";
import type { Permission } from "../../../src/domain/access/permissions";
import type { ProjectCatalog } from "../../../src/application/project-catalog";
import { invalid, notFound } from "../../../src/application/errors";
import type { ResourceRecord } from "../../../src/application/ports/project-repository";
import type {
  JsonSchema,
  ToolAnnotations,
  ToolDefinition,
} from "../../../src/shared/mcp/protocol";

/** A tool's result before the dispatcher wraps it in an MCP result. */
export interface RemoteToolOutcome {
  text: string;
  structured?: unknown;
}

/** What a remote tool handler runs against. */
export interface RemoteToolContext {
  context: ApplicationContext;
  catalog: ProjectCatalog;
}

/** One entry in the remote catalog. */
export interface RemoteTool {
  definition: ToolDefinition;
  /**
   * The permission the *credential* must carry to call this tool at all.
   *
   * It is the operation's own permission (`resource:update`), not an
   * MCP-specific one: the credential half is checked by the dispatcher and the
   * project-role half by the catalog use case the tool calls, so scopes and
   * membership compose exactly as they do for the HTTP API.
   */
  requiredPermission: Permission;
  run(
    args: Record<string, unknown>,
    context: RemoteToolContext,
  ): Promise<RemoteToolOutcome>;
}

/** A string property in a tool's input schema. */
function stringProp(description: string): JsonSchema {
  return { type: "string", description };
}

/** A numeric property in a tool's input schema. */
function numberProp(description: string): JsonSchema {
  return { type: "number", description };
}

/** A string property restricted to an enum of values. */
function enumProp(values: string[], description: string): JsonSchema {
  return { type: "string", enum: values, description };
}

/** A boolean property in a tool's input schema. */
function booleanProp(description: string): JsonSchema {
  return { type: "boolean", description };
}

/** An object input schema. */
function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

/** The read-only annotations a client uses for trust decisions. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** The write annotations. */
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Read a required non-empty string argument. */
function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(
      `The "${name}" argument is required and must be a non-empty string.`,
    );
  }
  return value;
}

/** Read a required integer argument. */
function requiredInteger(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid(`The "${name}" argument is required and must be an integer.`);
  }
  return value;
}

/** Read an optional boolean argument, defaulting to `false`. */
function optionalBoolean(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw invalid(`The "${name}" argument must be a boolean when present.`);
  }
  return value;
}

/** The known resource types, named once. */
const RESOURCE_TYPES: ResourceRecord["type"][] = [
  "sequence-diagram",
  "event-flow",
  "markdown-document",
];

/** Read a resource type argument. */
function requiredType(
  args: Record<string, unknown>,
  name: string,
): ResourceRecord["type"] {
  const value = requiredString(args, name);
  if (!(RESOURCE_TYPES as string[]).includes(value)) {
    throw invalid(
      `The "${name}" argument must be one of: ${RESOURCE_TYPES.join(", ")}.`,
    );
  }
  return value as ResourceRecord["type"];
}

/** A resource's identity rendered for a model. */
function describeResource(resource: {
  id: string;
  path: string;
  type: string;
  revision: number;
}): string {
  return `- ${resource.path} [${resource.type}] id=${resource.id} revision=${resource.revision}`;
}

/**
 * Resolve an agent-supplied reference to a resource id.
 *
 * A reference is matched as an id first and a path second. The listing that
 * performs the match is itself authorized, so a reference to a resource in
 * another project or another user's project simply does not resolve — the tool
 * never learns whether it exists.
 */
async function resolveResourceId(
  context: RemoteToolContext,
  projectId: string,
  reference: string,
): Promise<string> {
  const resources = await context.catalog.listResources(
    context.context,
    projectId,
  );
  const match =
    resources.find((resource) => resource.id === reference) ??
    resources.find((resource) => resource.path === reference);
  if (!match) {
    throw notFound(
      `No resource "${reference}" in project ${projectId}. Use list_resources to see the ids and paths that exist.`,
    );
  }
  return match.id;
}

/** Every tool the remote server exposes, in a deterministic order. */
export function createRemoteTools(): RemoteTool[] {
  return [
    {
      requiredPermission: "project:read",
      definition: {
        name: "list_projects",
        title: "List projects",
        description:
          "List every server project the authenticated user can see, with the caller's role and resource count. Call this first: the project ids it returns are what every other tool addresses. Returns `{ projects: [{ id, name, slug, role, resourceCount }] }`.",
        inputSchema: objectSchema({}),
        annotations: { ...READ_ONLY, title: "List projects" },
      },
      async run(_args, context) {
        const listings = await context.catalog.listProjects(context.context);
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
      requiredPermission: "project:read",
      definition: {
        name: "get_project",
        title: "Get a project",
        description:
          "Read one project's identity and what the caller may do in it (`role`, and the `permissions` the credential and role together grant). Use it to check whether a write is possible before attempting one. Returns `{ project, access }`.",
        inputSchema: objectSchema(
          {
            projectId: stringProp("The project id from list_projects."),
          },
          ["projectId"],
        ),
        annotations: { ...READ_ONLY, title: "Get a project" },
      },
      async run(args, context) {
        const projectId = requiredString(args, "projectId");
        const listing = await context.catalog.getProject(
          context.context,
          projectId,
        );
        const access = await context.catalog.describeAccess(
          context.context,
          projectId,
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
      requiredPermission: "resource:read",
      definition: {
        name: "list_resources",
        title: "List resources",
        description:
          "List a project's resources: each with its stable id, path and current revision. The revision is what a write must present as `expectedRevision`, so read it here (or from read_resource) before updating. Returns `{ projectId, resources }`.",
        inputSchema: objectSchema(
          {
            projectId: stringProp("The project id from list_projects."),
          },
          ["projectId"],
        ),
        annotations: { ...READ_ONLY, title: "List resources" },
      },
      async run(args, context) {
        const projectId = requiredString(args, "projectId");
        const resources = await context.catalog.listResources(
          context.context,
          projectId,
        );
        const text =
          resources.length === 0
            ? `Project ${projectId} has no resources yet. Create one with create_resource.`
            : resources.map(describeResource).join("\n");
        return { text, structured: { projectId, resources } };
      },
    },

    {
      requiredPermission: "resource:read",
      definition: {
        name: "read_resource",
        title: "Read a resource",
        description:
          "Read one resource's full text together with its identity and current revision. `resource` accepts the resource id or its path. Always read before updating, so you hold the revision the write must present. Returns `{ resource, content }`.",
        inputSchema: objectSchema(
          {
            projectId: stringProp("The project id from list_projects."),
            resource: stringProp("The resource id or path to read."),
          },
          ["projectId", "resource"],
        ),
        annotations: { ...READ_ONLY, title: "Read a resource" },
      },
      async run(args, context) {
        const projectId = requiredString(args, "projectId");
        const resourceId = await resolveResourceId(
          context,
          projectId,
          requiredString(args, "resource"),
        );
        const { resource, content } = await context.catalog.readResource(
          context.context,
          projectId,
          resourceId,
        );
        return {
          text: `${resource.path} [${resource.type}] id=${resource.id} revision=${resource.revision}\n\n${content}`,
          structured: { resource, content },
        };
      },
    },

    {
      requiredPermission: "resource:create",
      definition: {
        name: "create_resource",
        title: "Create a resource",
        description:
          "Create a new document at a project-relative path. Fails if a resource already exists there: to change an existing one, read it and call update_resource with its revision. Returns `{ resource }` with the new resource's id and revision 1.",
        inputSchema: objectSchema(
          {
            projectId: stringProp("The project id from list_projects."),
            path: stringProp(
              'The project-relative path, for example "checkout.seq" or "notes/overview.md". No absolute paths or "..".',
            ),
            type: enumProp(
              RESOURCE_TYPES,
              "What is being created: a sequence diagram, an event flow, or a markdown document.",
            ),
            content: stringProp("The full text of the new resource."),
          },
          ["projectId", "path", "type", "content"],
        ),
        annotations: { ...WRITE, title: "Create a resource" },
      },
      async run(args, context) {
        const projectId = requiredString(args, "projectId");
        const resource = await context.catalog.createResource(
          context.context,
          projectId,
          {
            path: requiredString(args, "path"),
            type: requiredType(args, "type"),
            content: typeof args.content === "string" ? args.content : "",
          },
        );
        return {
          text: `Created ${resource.path} (id: ${resource.id}, revision: ${resource.revision}).`,
          structured: { resource },
        };
      },
    },

    {
      requiredPermission: "resource:update",
      definition: {
        name: "update_resource",
        title: "Update a resource",
        description:
          "Replace a resource's text. `expectedRevision` is required and must be the revision you last read: a stale value is refused with a conflict instead of overwriting a concurrent edit. On conflict, re-read the resource and retry at its current revision. Returns `{ resource }` with the new revision.",
        inputSchema: objectSchema(
          {
            projectId: stringProp("The project id from list_projects."),
            resource: stringProp("The resource id or path to update."),
            content: stringProp("The complete new text."),
            expectedRevision: numberProp(
              "The revision you last read, from read_resource or list_resources. Required.",
            ),
          },
          ["projectId", "resource", "content", "expectedRevision"],
        ),
        annotations: { ...WRITE, title: "Update a resource" },
      },
      async run(args, context) {
        const projectId = requiredString(args, "projectId");
        const resourceId = await resolveResourceId(
          context,
          projectId,
          requiredString(args, "resource"),
        );
        const resource = await context.catalog.updateResource(
          context.context,
          projectId,
          resourceId,
          {
            content: typeof args.content === "string" ? args.content : "",
            expectedRevision: requiredInteger(args, "expectedRevision"),
          },
        );
        return {
          text: `Updated ${resource.path}; it is now at revision ${resource.revision}.`,
          structured: { resource },
        };
      },
    },

    {
      requiredPermission: "resource:move",
      definition: {
        name: "move_resource",
        title: "Move or rename a resource",
        description:
          "Move a resource to another project-relative path, keeping its id and revision history. `expectedRevision` is required and stale values are refused with a conflict. Returns `{ resource }` with the new path and revision.",
        inputSchema: objectSchema(
          {
            projectId: stringProp("The project id from list_projects."),
            resource: stringProp("The resource id or path to move."),
            path: stringProp("The new project-relative path."),
            expectedRevision: numberProp(
              "The revision you last read. Required.",
            ),
          },
          ["projectId", "resource", "path", "expectedRevision"],
        ),
        annotations: { ...WRITE, title: "Move or rename a resource" },
      },
      async run(args, context) {
        const projectId = requiredString(args, "projectId");
        const resourceId = await resolveResourceId(
          context,
          projectId,
          requiredString(args, "resource"),
        );
        const resource = await context.catalog.moveResource(
          context.context,
          projectId,
          resourceId,
          {
            path: requiredString(args, "path"),
            expectedRevision: requiredInteger(args, "expectedRevision"),
          },
        );
        return {
          text: `Moved to ${resource.path}; it is now at revision ${resource.revision}.`,
          structured: { resource },
        };
      },
    },

    {
      requiredPermission: "resource:delete",
      definition: {
        name: "delete_resource",
        title: "Delete a resource",
        description:
          "Delete a resource permanently. Requires `confirm: true`; without it the call fails and explains what would be removed, so an accidental invocation cannot destroy work. Returns `{ deleted }`.",
        inputSchema: objectSchema(
          {
            projectId: stringProp("The project id from list_projects."),
            resource: stringProp("The resource id or path to delete."),
            confirm: booleanProp("Must be true to actually delete."),
          },
          ["projectId", "resource", "confirm"],
        ),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
          title: "Delete a resource",
        },
      },
      async run(args, context) {
        const projectId = requiredString(args, "projectId");
        const reference = requiredString(args, "resource");
        const resourceId = await resolveResourceId(
          context,
          projectId,
          reference,
        );
        if (!optionalBoolean(args, "confirm")) {
          const resource = await context.catalog.getResource(
            context.context,
            projectId,
            resourceId,
          );
          throw invalid(
            `Refusing to delete "${resource.path}" without confirmation. Call delete_resource again with confirm: true.`,
          );
        }
        const resource = await context.catalog.getResource(
          context.context,
          projectId,
          resourceId,
        );
        await context.catalog.deleteResource(
          context.context,
          projectId,
          resourceId,
        );
        return {
          text: `Deleted ${resource.path} (id: ${resource.id}).`,
          structured: { deleted: resource },
        };
      },
    },
  ];
}

/** Look a remote tool up by name. */
export function findRemoteTool(
  tools: RemoteTool[],
  name: string,
): RemoteTool | undefined {
  return tools.find((tool) => tool.definition.name === name);
}
