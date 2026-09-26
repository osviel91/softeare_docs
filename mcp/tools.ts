/**
 * The MCP tool catalog.
 *
 * A tool is a name, a JSON Schema, a description, trust annotations, and a
 * handler. The descriptions carry real weight here: a model chooses a tool from
 * its description alone, so each one says what it does, when to reach for it,
 * what it returns, and which reference resource explains the language it writes.
 * The annotations matter too — a client that treats this server as untrusted
 * (Hermes' `trust: untrusted`) auto-approves only tools marked
 * `readOnlyHint: true`, so read and write are distinguished honestly.
 *
 * Handlers never touch the protocol: they receive decoded arguments plus the
 * {@link DocumentationWorkspace}, and return text and structured content. A
 * thrown `Error` becomes an MCP tool-execution error, which is what lets the
 * model read the message and correct itself.
 */
import type { DocumentationWorkspace } from "./workspace";
import type {
  DocumentationAudit,
  DiagnosticView,
  ResourceSummary,
  RenderResult,
} from "./workspace";
import type { OutlineNode } from "../src/domain/outline/outline";
import type { JsonSchema, ToolDefinition } from "./protocol";
import { analyzeEventFlow } from "../src/language/eventflow/parser";
import { effectsFor, handlersFor, resultingEventsFor } from "../src/domain/eventflow/causality";
import { analyze } from "../src/language/analyze";
import { semanticMessagesOf } from "../src/domain/diagram/semantic-messages";
import { walkStatements } from "../src/domain/diagram/ast";
import { semanticMessageCandidates, traceSemanticMessage } from "../src/domain/project/semantic-message-trace";

/** What a tool handler returns before it is wrapped in an MCP result. */
export interface ToolOutcome {
  /** The human/model-readable form of the result. */
  text: string;
  /** The machine-readable form; also serialized into the text block. */
  structured?: unknown;
}

/** The context a handler runs against. */
export interface ToolContext {
  workspace: DocumentationWorkspace;
}

/** One catalog entry. */
export interface Tool {
  definition: ToolDefinition;
  run(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolOutcome>;
}

/** A string property in a tool's input schema. */
function stringProp(description: string): JsonSchema {
  return { type: "string", description };
}

/** A boolean property in a tool's input schema. */
function booleanProp(description: string): JsonSchema {
  return { type: "boolean", description };
}

/** A numeric property in a tool's input schema. */
function numberProp(description: string): JsonSchema {
  return { type: "number", description };
}

/** A string property restricted to an enum of values. */
function enumProp(values: string[], description: string): JsonSchema {
  return { type: "string", enum: values, description };
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

/** Read a required string argument, or throw a message the model can act on. */
function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `The "${name}" argument is required and must be a non-empty string.`,
    );
  }
  return value;
}

/** Read an optional string argument. */
function optionalString(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`The "${name}" argument must be a string when present.`);
  }
  return value;
}

/** Read an optional boolean argument, defaulting to `false`. */
function optionalBoolean(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw new Error(`The "${name}" argument must be a boolean when present.`);
  }
  return value;
}

/** Read an optional numeric argument. */
function optionalNumber(
  args: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `The "${name}" argument must be a finite number when present.`,
    );
  }
  return value;
}

/** `key: value` lines for a resource, used in list and read output. */
function describeResource(resource: ResourceSummary): string {
  const shape = Object.entries(resource.metrics)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  return [
    `- ${resource.path} [${resource.type}] id=${resource.id} title="${resource.title}"${
      resource.titleDeclared ? "" : " (no declared title)"
    }`,
    shape === "" ? "" : `  (${shape})`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** A diagnostics block, or a reassuring line when there are none. */
function describeDiagnostics(diagnostics: DiagnosticView[]): string {
  if (diagnostics.length === 0) return "No diagnostics.";
  return diagnostics
    .map((diagnostic) => {
      const where =
        diagnostic.line === undefined
          ? (diagnostic.resourcePath ?? diagnostic.resourceId)
          : `${diagnostic.resourcePath ?? diagnostic.resourceId}:${diagnostic.line}${
              diagnostic.column === undefined ? "" : `:${diagnostic.column}`
            }`;
      const code = diagnostic.code === undefined ? "" : ` (${diagnostic.code})`;
      return `- [${diagnostic.severity}] ${where}: ${diagnostic.message}${code}`;
    })
    .join("\n");
}

/** A nested outline rendered as an indented list. */
function describeOutline(nodes: readonly OutlineNode[], depth = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(
      `${"  ".repeat(depth)}- ${node.label} [${node.kind}] line ${node.line}`,
    );
    if (node.children.length > 0) {
      lines.push(describeOutline(node.children, depth + 1));
    }
  }
  return lines.join("\n");
}

/** A project audit rendered for reading. */
function describeAudit(audit: DocumentationAudit): string {
  const { summary } = audit;
  const header =
    `Audit of "${audit.project.name}": ${summary.resources} resources ` +
    `(${summary.diagrams} diagrams, ${summary.documents} documents), ` +
    `${summary.links} links, ${summary.errors} errors, ` +
    `${summary.warnings} warnings, ${summary.suggestions} suggestions.`;
  if (audit.findings.length === 0) {
    return `${header}\nNo documentation gaps found.`;
  }
  const findings = audit.findings
    .map((finding) => {
      const where =
        finding.path === undefined
          ? ""
          : ` (${finding.path}${finding.line === undefined ? "" : `:${finding.line}`})`;
      return `- [${finding.severity}] ${finding.code}: ${finding.message}${where}${
        finding.suggestion === undefined ? "" : `\n  → ${finding.suggestion}`
      }`;
    })
    .join("\n");
  return `${header}\n${findings}`;
}

/** A rendered diagram described for reading. */
function describeRender(result: RenderResult): string {
  const location =
    result.output === undefined
      ? "returned inline"
      : `written to ${result.output}`;
  return `Rendered "${result.resource}" to SVG: ${result.width}×${result.height}px, ${result.bytes} bytes, ${location}.`;
}

/** Every tool the server exposes, in a deterministic order. */
export function createTools(): Tool[] {
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const write = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };

  return [
    {
      definition: {
        name: "list_projects",
        title: "List documentation projects",
        description:
          "List every project in the workspace with its resource and diagnostic counts. A project is a subdirectory of the workspace and holds the diagrams, event flows and markdown documents for one system. Call this first when you do not know what already exists. Returns `{ workspace, projects: [{ id, name, resources, diagrams, eventFlows, documents, errors, warnings }] }`.",
        inputSchema: objectSchema({}),
        annotations: { ...readOnly, title: "List documentation projects" },
      },
      async run(_args, context) {
        const projects = await context.workspace.listProjects();
        const text =
          projects.length === 0
            ? `The workspace at ${context.workspace.describe} has no projects yet. Create one with create_project, or add a subdirectory to the workspace.`
            : projects
                .map(
                  (project) =>
                    `- ${project.id} "${project.name}": ${project.resources} resources (${project.diagrams} diagrams, ${project.eventFlows} event flows, ${project.documents} documents), ${project.errors} errors, ${project.warnings} warnings`,
                )
                .join("\n");
        return {
          text,
          structured: { workspace: context.workspace.describe, projects },
        };
      },
    },

    {
      definition: {
        name: "find_retry_behavior",
        title: "Find failure and retry behavior",
        description: "Find documented failure and retry semantics across event flows. It never infers retries from queues or asynchronous messaging and reports absent policy as unknown.",
        inputSchema: objectSchema({ project: stringProp("Project id or name."), mechanism: enumProp(["broker", "handler", "application", "scheduler", "external", "unknown"], "Optional retry mechanism filter.") }),
        annotations: { ...readOnly, title: "Find failure and retry behavior" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(optionalString(args, "project"));
        const wanted = optionalString(args, "mechanism");
        const flows: unknown[] = [];
        for (const resource of await context.workspace.listResources(project)) {
          if (resource.type !== "event-flow") continue;
          const { content } = await context.workspace.readResource(project, resource.id);
          const { flow } = analyzeEventFlow(content);
          const retries = (flow.causal?.retries ?? []).filter((retry) => wanted === undefined || retry.mechanism === wanted);
          const failures = flow.causal?.failures ?? [];
          if (retries.length || (wanted === undefined && failures.length)) flows.push({ resource: resource.path, failures, retries, unknownPolicy: retries.some((retry) => !retry.mechanism || !retry.exhaustion) });
        }
        return { text: flows.length ? flows.map((flow) => { const item = flow as { resource: string; failures: unknown[]; retries: unknown[]; unknownPolicy: boolean }; return `- ${item.resource}: ${item.retries.length} retries, ${item.failures.length} failures${item.unknownPolicy ? " (policy or exhaustion unknown)" : ""}`; }).join("\n") : "No documented failure or retry behavior found.", structured: { mechanism: wanted, flows } };
      },
    },

    {
      definition: {
        name: "list_resource_relationships",
        title: "List resource relationships",
        description:
          "List semantic relationships in a project. Complementary views are stable-id links between a Sequence and an Event Flow that document the same behavior from execution and causal perspectives; they are not generic hyperlinks.",
        inputSchema: objectSchema({
          project: stringProp("Project id or name."),
        }),
        annotations: { ...readOnly, title: "List resource relationships" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(optionalString(args, "project"));
        const relationships = await context.workspace.listRelationships(project);
        return {
          text: relationships.length === 0 ? "No semantic resource relationships." : JSON.stringify(relationships),
          structured: { project: { id: project.id, name: project.name }, relationships },
        };
      },
    },

    {
      definition: {
        name: "create_resource_relationship",
        title: "Create resource relationship",
        description:
          "Declare two existing resources as complementary views of substantially the same behavior. Use only when both views add materially different information; do not create a Sequence/Event Flow pair mechanically.",
        inputSchema: objectSchema(
          {
            project: stringProp("Project id or name."),
            source: stringProp("Stable id, path, or title of the first resource."),
            target: stringProp("Stable id, path, or title of the second resource."),
            sourceRole: enumProp(["execution", "causal", "other"], "Optional role of the first resource."),
            targetRole: enumProp(["execution", "causal", "other"], "Optional role of the second resource."),
          },
          ["source", "target"],
        ),
        annotations: { ...write, title: "Create resource relationship" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(optionalString(args, "project"));
        const index = await context.workspace.index(project);
        const source = context.workspace.resolveResource(index, requiredString(args, "source"));
        const target = context.workspace.resolveResource(index, requiredString(args, "target"));
        const relationship = await context.workspace.createRelationship(project, {
          kind: "complementary-view",
          sourceId: source.id,
          targetId: target.id,
          ...(optionalString(args, "sourceRole") ? { sourceRole: optionalString(args, "sourceRole") as "execution" | "causal" | "other" } : {}),
          ...(optionalString(args, "targetRole") ? { targetRole: optionalString(args, "targetRole") as "execution" | "causal" | "other" } : {}),
        });
        return { text: `Created complementary view relationship: ${source.title} <-> ${target.title}.`, structured: { project: { id: project.id, name: project.name }, relationship } };
      },
    },

    {
      definition: {
        name: "create_project",
        title: "Create a documentation project",
        description:
          "Create a project: one subdirectory of the workspace that holds the documentation for a system, plus the `project.json` identity record that gives every file a stable id. Fails if a project of that name already exists. Returns the new project's summary.",
        inputSchema: objectSchema(
          {
            name: stringProp(
              'The project name, used as its directory name (for example "Payments"). No path separators.',
            ),
          },
          ["name"],
        ),
        annotations: { ...write, title: "Create a documentation project" },
      },
      async run(args, context) {
        const project = await context.workspace.createProject(
          requiredString(args, "name"),
        );
        return {
          text: `Created project "${project.name}" (id: ${project.id}). Add its first document with create_resource.`,
          structured: project,
        };
      },
    },

    {
      definition: {
        name: "get_project_overview",
        title: "Project overview",
        description:
          "The dashboard for one project: resource counts, every declared symbol grouped by kind (participants, actors, events, channels, brokers, services), the diagnostic totals, and a compact resource list. Use it to orient before writing, and to see which names already exist so a new diagram reuses them instead of inventing parallel ones. Returns `{ project, counts, diagnosticsBySeverity, symbols, resources }`.",
        inputSchema: objectSchema({
          project: stringProp(
            "Project id or name. Optional when the workspace has exactly one project.",
          ),
        }),
        annotations: { ...readOnly, title: "Project overview" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(
          optionalString(args, "project"),
        );
        const overview = await context.workspace.overview(project);
        const counts = overview.counts as Record<string, number>;
        const severities = overview.diagnosticsBySeverity as Record<
          string,
          number
        >;
        const symbols = overview.symbols as Record<string, string[]>;
        const symbolLines = Object.entries(symbols)
          .map(([kind, names]) => `- ${kind}: ${names.join(", ")}`)
          .join("\n");
        return {
          text: [
            `Project "${project.name}" (id: ${project.id}): ${counts.resources} resources, ${counts.symbols} symbols, ${severities.error ?? 0} errors, ${severities.warning ?? 0} warnings.`,
            "",
            symbolLines === "" ? "No symbols declared yet." : symbolLines,
          ].join("\n"),
          structured: overview,
        };
      },
    },

    {
      definition: {
        name: "list_resources",
        title: "List resources",
        description:
          "List the resources of one project: each with its stable id, file path, type (`sequence-diagram`, `event-flow`, or `markdown-document`), display title, whether it declares a title, and shape metrics (participants/messages, events/producers/consumers/channels, or words). Use it to find a resource's id before reading or updating it. Returns `{ project, resources }`.",
        inputSchema: objectSchema({
          project: stringProp(
            "Project id or name. Optional when the workspace has exactly one project.",
          ),
        }),
        annotations: { ...readOnly, title: "List resources" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(
          optionalString(args, "project"),
        );
        const resources = await context.workspace.listResources(project);
        const text =
          resources.length === 0
            ? `Project "${project.name}" has no resources yet. Create one with create_resource.`
            : resources.map(describeResource).join("\n");
        return {
          text,
          structured: {
            project: { id: project.id, name: project.name },
            resources,
          },
        };
      },
    },

    {
      definition: {
        name: "read_resource",
        title: "Read a resource",
        description:
          "Read one resource's full text — DSL source for a diagram or event flow, markdown for a document — together with its identity. `resource` accepts the stable id (`diagram-checkout`), the file path (`checkout.seq`), the bare file name, or the display title. Use this before updating a document so the whole text is in context, and pair it with get_outline when you only need the structure. Returns `{ resource, content }`.",
        inputSchema: objectSchema(
          {
            project: stringProp(
              "Project id or name. Optional when the workspace has exactly one project.",
            ),
            resource: stringProp(
              "The resource to read: stable id, path, file name, or title.",
            ),
          },
          ["resource"],
        ),
        annotations: { ...readOnly, title: "Read a resource" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(
          optionalString(args, "project"),
        );
        const { resource, content } = await context.workspace.readResource(
          project,
          requiredString(args, "resource"),
        );
        const parsed = resource.type === "sequence-diagram" ? analyze(content).ast : null;
        const semanticMessages = parsed ? semanticMessagesOf(parsed) : undefined;
        return {
          text: `${resource.path} [${resource.type}] id=${resource.id} title="${resource.title}"\n\n${content}`,
          structured: { resource, content, ...(semanticMessages ? { semanticMessages } : {}) },
        };
      },
    },

    {
      definition: {
        name: "get_outline",
        title: "Resource outline",
        description:
          "The structural tree of one resource: for a diagram, its title, participants, and nested flow with fragments and notes; for an event flow, its events (with metadata), services, channels, brokers, and causal edges; for a markdown document, its heading tree. Cheaper than reading the whole text when you need to know what a document contains. Returns `{ resource, outline }` with nested `{ id, label, kind, line, children }` nodes.",
        inputSchema: objectSchema(
          {
            project: stringProp(
              "Project id or name. Optional when the workspace has exactly one project.",
            ),
            resource: stringProp("The resource to outline."),
          },
          ["resource"],
        ),
        annotations: { ...readOnly, title: "Resource outline" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(
          optionalString(args, "project"),
        );
        const { resource, outline } = await context.workspace.outline(
          project,
          requiredString(args, "resource"),
        );
        return {
          text: `Outline of ${resource.path}:\n${describeOutline(outline)}`,
          structured: { resource, outline },
        };
      },
    },

    {
      definition: {
        name: "search_documentation",
        title: "Search documentation",
        description:
          'Search the text of every resource, in one project or across the workspace. The query understands scopes as whitespace-separated tokens: `kind:diagram`, `kind:note`, `project:Name`, and `participant:Name`. A filter-only query (for example `participant:PaymentService`) lists the documents that match it, which answers "where is this used?". Plain words are matched case-insensitively. Returns `{ query, scanned, matches: [{ projectId, id, path, title, line, column, excerpt }] }`.',
        inputSchema: objectSchema(
          {
            query: stringProp(
              "The search query, optionally scoped with kind:, project:, or participant:.",
            ),
            project: stringProp(
              "Restrict to one project. Omit to search the whole workspace.",
            ),
            limit: numberProp("Maximum matches to return. Defaults to 200."),
          },
          ["query"],
        ),
        annotations: { ...readOnly, title: "Search documentation" },
      },
      async run(args, context) {
        const projectName = optionalString(args, "project");
        const project =
          projectName === undefined
            ? null
            : await context.workspace.resolveProject(projectName);
        const result = await context.workspace.search(
          project,
          requiredString(args, "query"),
          optionalNumber(args, "limit"),
        );
        const text =
          result.matches.length === 0
            ? `No matches for "${result.query}" across ${result.scanned} resources.`
            : result.matches
                .map(
                  (match) =>
                    `- ${match.projectName} › ${match.name}:${match.line}:${match.column}${match.excerpt === "" ? "" : ` — ${match.excerpt}`}`,
                )
                .join("\n");
        return { text, structured: result };
      },
    },

    {
      definition: {
        name: "find_references",
        title: "Find symbol references",
        description:
          'Every declaration and usage of a symbol name in one project, with the exact line and column of each site. Participant ids are shared across a project, so this answers "where is PaymentService declared and used?". Use it before renaming a symbol or before concluding that a component is undocumented. Returns `{ name, sites: [{ resourceId, resourcePath, resourceTitle, line, column, role, context }], declaredIn }`.',
        inputSchema: objectSchema(
          {
            project: stringProp(
              "Project id or name. Optional when the workspace has exactly one project.",
            ),
            name: stringProp(
              'The symbol name exactly as written (for example "PaymentService").',
            ),
          },
          ["name"],
        ),
        annotations: { ...readOnly, title: "Find symbol references" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(
          optionalString(args, "project"),
        );
        const result = await context.workspace.findReferences(
          project,
          requiredString(args, "name"),
        );
        const text =
          result.sites.length === 0
            ? `"${result.name}" is not declared or used anywhere in project "${project.name}".`
            : result.sites
                .map(
                  (site) =>
                    `- ${site.resourcePath}:${site.line}:${site.column} [${site.role}/${site.context}]`,
                )
                .join("\n");
        return { text, structured: result };
      },
    },

    {
      definition: {
        name: "create_resource",
        title: "Create a resource",
        description:
          "Create a diagram, an event flow, or a markdown document in a project. `content` is the full text (DSL source or markdown). The file extension is derived from `kind` (`.seq`, `.eventseq`, `.md`) so the project stays readable on disk. When `title` is given and the text declares none, a `title` line (or a `# Heading` for markdown) is prepended. Fails rather than overwrite unless `overwrite: true`. Validates what was written and returns `{ resource, created, diagnostics }` — fix any error before continuing. Read `sequencediagrams://reference/sequence-dsl`, `.../event-flow-dsl`, or `.../markdown` before writing.",
        inputSchema: objectSchema(
          {
            project: stringProp(
              "Project id or name. Optional when the workspace has exactly one project.",
            ),
            kind: enumProp(
              ["diagram", "event-flow", "note"],
              "What to create: a sequence diagram (`.seq`), an event flow (`.eventseq`), or a markdown document (`.md`).",
            ),
            name: stringProp(
              'The file name, without or with extension (for example "checkout-flow" or "checkout-flow.seq"). No path separators.',
            ),
            content: stringProp("The full text of the new resource."),
            title: stringProp(
              "A display title, prepended when the text declares none.",
            ),
            overwrite: booleanProp(
              "Replace an existing file of the same name. Defaults to false, which fails instead.",
            ),
          },
          ["kind", "name", "content"],
        ),
        annotations: { ...write, title: "Create a resource" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(
          optionalString(args, "project"),
        );
        const kind = requiredString(args, "kind");
        if (kind !== "diagram" && kind !== "event-flow" && kind !== "note") {
          throw new Error(
            'The "kind" argument must be "diagram", "event-flow", or "note".',
          );
        }
        const result = await context.workspace.createResource(project, {
          kind,
          name: requiredString(args, "name"),
          content: requiredString(args, "content"),
          title: optionalString(args, "title"),
          overwrite: optionalBoolean(args, "overwrite"),
        });
        const action = result.created ? "Created" : "Replaced";
        return {
          text: [
            `${action} ${result.resource.path} (id: ${result.resource.id}, title: "${result.resource.title}").`,
            describeDiagnostics(result.diagnostics),
          ].join("\n"),
          structured: result,
        };
      },
    },

    {
      definition: {
        name: "update_resource",
        title: "Update a resource",
        description:
          'Change a resource\'s text. `mode: "replace"` (the default) swaps the whole document; `"append"` adds to the end; `"prepend"` adds to the beginning. Read the resource first when replacing it, so no existing content is lost. On a server workspace the resource carries a revision: pass the `expectedRevision` you last read to avoid overwriting a concurrent edit, and the response returns the new `revision`. A stale expectation is refused rather than silently applied. Validates the result and returns `{ resource, revision, mode, bytesBefore, bytesAfter, diagnostics }`.',
        inputSchema: objectSchema(
          {
            project: stringProp(
              "Project id or name. Optional when the workspace has exactly one project.",
            ),
            resource: stringProp(
              "The resource to update: stable id, path, file name, or title.",
            ),
            content: stringProp("The text to write."),
            mode: enumProp(
              ["replace", "append", "prepend"],
              "How to apply the text. Defaults to replace.",
            ),
            expectedRevision: numberProp(
              "The revision you last read, when the workspace is a server workspace. A stale value is refused with a conflict instead of overwriting a concurrent edit.",
            ),
          },
          ["resource", "content"],
        ),
        annotations: { ...write, title: "Update a resource" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(
          optionalString(args, "project"),
        );
        const mode = optionalString(args, "mode");
        if (
          mode !== undefined &&
          mode !== "replace" &&
          mode !== "append" &&
          mode !== "prepend"
        ) {
          throw new Error(
            'The "mode" argument must be "replace", "append", or "prepend".',
          );
        }
        const expectedRevision = optionalNumber(args, "expectedRevision");
        const result = await context.workspace.updateResource(
          project,
          requiredString(args, "resource"),
          {
            content: requiredString(args, "content"),
            mode,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          },
        );
        return {
          text: [
            `Updated ${result.resource.path} (${result.mode}); ${result.bytesBefore} → ${result.bytesAfter} bytes.`,
            describeDiagnostics(result.diagnostics),
          ].join("\n"),
          structured: result,
        };
      },
    },

    {
      definition: {
        name: "rename_resource",
        title: "Rename a resource",
        description:
          "Rename a resource's file. The resource keeps its stable id, and the identity record moves with it, so every `resource://`, `diagram://` and `doc://` link keeps resolving — this is the safe way to reorganize a project. Refuses to overwrite an existing file. Returns `{ resource, renamedFrom }`.",
        inputSchema: objectSchema(
          {
            project: stringProp(
              "Project id or name. Optional when the workspace has exactly one project.",
            ),
            resource: stringProp("The resource to rename."),
            newName: stringProp(
              "The new file name. A markdown document gains `.md` when it lacks one.",
            ),
          },
          ["resource", "newName"],
        ),
        annotations: { ...write, title: "Rename a resource" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(
          optionalString(args, "project"),
        );
        const result = await context.workspace.renameResource(
          project,
          requiredString(args, "resource"),
          requiredString(args, "newName"),
        );
        return {
          text: `Renamed ${result.renamedFrom} → ${result.resource.path}; the stable id is still ${result.resource.id}, so existing links keep working.`,
          structured: result,
        };
      },
    },

    {
      definition: {
        name: "delete_resource",
        title: "Delete a resource",
        description:
          "Delete a resource from a project permanently. Requires `confirm: true`; without it the call fails and explains what would be removed, so an accidental invocation cannot destroy work. Prefer updating a document over deleting it unless the user asked for removal.",
        inputSchema: objectSchema(
          {
            project: stringProp(
              "Project id or name. Optional when the workspace has exactly one project.",
            ),
            resource: stringProp("The resource to delete."),
            confirm: booleanProp(
              "Must be true. Confirms the file is really to be removed from disk.",
            ),
          },
          ["resource", "confirm"],
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
        const project = await context.workspace.resolveProject(
          optionalString(args, "project"),
        );
        const result = await context.workspace.deleteResource(
          project,
          requiredString(args, "resource"),
          optionalBoolean(args, "confirm"),
        );
        return {
          text: `Deleted ${result.deleted.path} (id: ${result.deleted.id}) from project "${project.name}".`,
          structured: result,
        };
      },
    },

    {
      definition: {
        name: "validate_source",
        title: "Validate source text",
        description:
          "Validate text you have not written yet, as a diagram, event flow, or markdown document, and return the diagnostics the project index would report for it. This is the self-correction loop: draft, validate, fix, then create. Diagnostics carry a 1-based line and column so a fix is mechanical. Returns `{ diagnostics: [{ severity, code, message, line, column }] }`.",
        inputSchema: objectSchema(
          {
            content: stringProp("The text to validate."),
            kind: enumProp(
              ["diagram", "event-flow", "note"],
              "Which language to validate the text as.",
            ),
          },
          ["content", "kind"],
        ),
        annotations: { ...readOnly, title: "Validate source text" },
      },
      async run(args, context) {
        const kind = requiredString(args, "kind");
        if (kind !== "diagram" && kind !== "event-flow" && kind !== "note") {
          throw new Error(
            'The "kind" argument must be "diagram", "event-flow", or "note".',
          );
        }
        const diagnostics = context.workspace.validateSource(
          requiredString(args, "content"),
          kind,
        );
        return {
          text: describeDiagnostics(diagnostics),
          structured: { diagnostics },
        };
      },
    },

    {
      definition: {
        name: "validate_resource",
        title: "Validate a resource",
        description:
          "Validate one existing resource and return its diagnostics, including semantic checks such as an unknown participant, a participant that is declared but never used, or an event with no producer. Returns `{ resource, diagnostics }`.",
        inputSchema: objectSchema(
          {
            project: stringProp(
              "Project id or name. Optional when the workspace has exactly one project.",
            ),
            resource: stringProp("The resource to validate."),
          },
          ["resource"],
        ),
        annotations: { ...readOnly, title: "Validate a resource" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(
          optionalString(args, "project"),
        );
        const result = await context.workspace.validateResource(
          project,
          requiredString(args, "resource"),
        );
        return {
          text: `Diagnostics for ${result.resource.path}:\n${describeDiagnostics(result.diagnostics)}`,
          structured: result,
        };
      },
    },

    {
      definition: {
        name: "validate_project",
        title: "Validate a project",
        description:
          "Every diagnostic in a project, each addressed to its resource and line: parse errors, unresolved participants, unused participants, duplicate ids or titles, broken references and embeds, and the event-driven checks. Use it as the gate before reporting work as done. Returns `{ summary, diagnostics }`.",
        inputSchema: objectSchema({
          project: stringProp(
            "Project id or name. Optional when the workspace has exactly one project.",
          ),
        }),
        annotations: { ...readOnly, title: "Validate a project" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(
          optionalString(args, "project"),
        );
        const result = await context.workspace.validateProject(project);
        return {
          text: `Project "${result.summary.name}": ${result.summary.errors} errors, ${result.summary.warnings} warnings across ${result.summary.resources} resources.\n${describeDiagnostics(result.diagnostics)}`,
          structured: result,
        };
      },
    },

    {
      definition: {
        name: "render_diagram",
        title: "Render a diagram to SVG",
        description:
          "Render a sequence diagram or event flow to SVG using the app's own layout and renderer, so what you document is what the editor draws. By default the SVG is returned inline; pass `output` (a workspace-relative path) to write it to a file instead. Markdown documents do not render. Returns `{ format, width, height, bytes, resource, svg? , output? }`.",
        inputSchema: objectSchema(
          {
            project: stringProp(
              "Project id or name. Optional when the workspace has exactly one project.",
            ),
            resource: stringProp("The diagram or event flow to render."),
            theme: enumProp(
              ["light", "dark"],
              "Colour scheme. Defaults to light.",
            ),
            background: stringProp(
              "Canvas fill: `white`, `transparent`, or any CSS colour.",
            ),
            padding: numberProp("Extra padding around the drawing, in pixels."),
            includeTitle: booleanProp(
              "Draw the diagram's title when it has one. Defaults to true.",
            ),
            output: stringProp(
              "A workspace-relative path to write the SVG to (for example `exports/checkout.svg`). When omitted the SVG is returned in the result.",
            ),
          },
          ["resource"],
        ),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          title: "Render a diagram to SVG",
        },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(
          optionalString(args, "project"),
        );
        const theme = optionalString(args, "theme");
        if (theme !== undefined && theme !== "light" && theme !== "dark") {
          throw new Error('The "theme" argument must be "light" or "dark".');
        }
        const result = await context.workspace.render(
          project,
          requiredString(args, "resource"),
          {
            theme: theme as "light" | "dark" | undefined,
            background: optionalString(args, "background"),
            padding: optionalNumber(args, "padding"),
            includeTitle:
              args.includeTitle === undefined
                ? undefined
                : optionalBoolean(args, "includeTitle"),
            output: optionalString(args, "output"),
          },
        );
        const header = describeRender(result);
        return {
          text:
            result.svg === undefined ? header : `${header}\n\n${result.svg}`,
          structured: result,
        };
      },
    },

    {
      definition: {
        name: "list_semantic_occurrences",
        title: "List semantic message occurrences",
        description: "List structured Sequence occurrences and Event Flow message entities with explicit authoritative bindings.",
        inputSchema: objectSchema({ project: stringProp("Project id or name.") }),
        annotations: { ...readOnly, title: "List semantic message occurrences" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(optionalString(args, "project"));
        const index = await context.workspace.index(project);
        const occurrences = index.semanticOccurrences ?? [];
        const eventFlowMessages = index.eventFlowMessages ?? [];
        const legacyCandidates = [];
        for (const resource of await context.workspace.listResources(project)) {
          if (resource.type !== "sequence-diagram") continue;
          const { content } = await context.workspace.readResource(project, resource.id);
          const ast = analyze(content).ast;
          for (const statement of ast ? walkStatements(ast.statements) : []) {
            if (statement.type !== "message" || statement.semantics || statement.label.trim() === "") continue;
            if (/(?:Event|Command)$/i.test(statement.label.trim()) || /\b(?:publish|consume|dispatch)\b/i.test(statement.label)) {
              legacyCandidates.push({ resourceId: resource.id, path: resource.path, label: statement.label, evidence: ["message text or suffix signal"] });
            }
          }
        }
        return { text: JSON.stringify({ occurrences, eventFlowMessages, legacyCandidates }), structured: { occurrences, eventFlowMessages, legacyCandidates } };
      },
    },
    {
      definition: {
        name: "find_semantic_message_candidates",
        title: "Find semantic message candidates",
        description: "Find exact-name semantic message candidates without mutating state or treating names as authoritative identity.",
        inputSchema: objectSchema({ project: stringProp("Project id or name.") }),
        annotations: { ...readOnly, title: "Find semantic message candidates" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(optionalString(args, "project"));
        const candidates = semanticMessageCandidates(await context.workspace.index(project));
        return { text: JSON.stringify(candidates), structured: { candidates } };
      },
    },
    {
      definition: {
        name: "get_semantic_message",
        title: "Get semantic message trace",
        description: "Inspect an explicit semantic message identity and its authoritative Sequence and Event Flow bindings.",
        inputSchema: objectSchema({ project: stringProp("Project id or name."), messageId: stringProp("Stable semantic message id.") }, ["messageId"]),
        annotations: { ...readOnly, title: "Get semantic message trace" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(optionalString(args, "project"));
        const trace = traceSemanticMessage(await context.workspace.index(project), requiredString(args, "messageId"));
        const downstream = [];
        for (const entity of trace.eventFlowEntities) {
          const resource = await context.workspace.readResource(project, entity.resourceId);
          const flow = analyzeEventFlow(resource.content).flow;
          for (const handler of handlersFor(flow, entity.name)) downstream.push({ resourceId: entity.resourceId, handler: handler.id, messages: resultingEventsFor(flow, handler.id), effects: effectsFor(flow, handler.id) });
        }
        const result = { ...trace, downstream };
        return { text: JSON.stringify(result), structured: result };
      },
    },
    {
      definition: {
        name: "list_semantic_messages",
        title: "List semantic message identities",
        description: "List explicit project-scoped semantic message identities. Equal names without bindings remain candidates, not identity.",
        inputSchema: objectSchema({ project: stringProp("Project id or name.") }),
        annotations: { ...readOnly, title: "List semantic message identities" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(optionalString(args, "project"));
        const messages = await context.workspace.listSemanticMessages(project);
        return { text: messages.length ? JSON.stringify(messages) : "No semantic message identities.", structured: { messages } };
      },
    },
    {
      definition: {
        name: "create_semantic_message",
        title: "Create semantic message identity",
        description: "Create or replace an explicit project-scoped event or command identity. This never binds equal names automatically.",
        inputSchema: objectSchema({ project: stringProp("Project id or name."), id: stringProp("Stable project-scoped id."), name: stringProp("Display name."), kind: enumProp(["event", "command"], "Architectural message kind.") }, ["id", "name", "kind"]),
        annotations: { ...write, title: "Create semantic message identity" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(optionalString(args, "project"));
        const message = { id: requiredString(args, "id"), name: requiredString(args, "name"), kind: requiredString(args, "kind") as "event" | "command" };
        await context.workspace.saveSemanticMessage(project, message);
        return { text: `Created semantic message ${message.id}.`, structured: { message } };
      },
    },
    {
      definition: {
        name: "bind_semantic_message",
        title: "Bind semantic message occurrence",
        description: "Bind one explicit Sequence occurrence or Event Flow event entity to an existing identity. Name matching is only a candidate and never performs this operation.",
        inputSchema: objectSchema({ project: stringProp("Project id or name."), resource: stringProp("Resource id or path."), messageId: stringProp("Existing semantic message id."), name: stringProp("Sequence semantic name or Event Flow event name."), step: numberProp("1-based Sequence message step; omit for Event Flow.") }, ["resource", "messageId", "name"]),
        annotations: { ...write, title: "Bind semantic message occurrence" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(optionalString(args, "project"));
        const identity = (await context.workspace.listSemanticMessages(project)).find((entry) => entry.id === requiredString(args, "messageId"));
        if (!identity) throw new Error(`Unknown semantic message "${requiredString(args, "messageId")}".`);
        const resource = context.workspace.resolveResource(await context.workspace.index(project), requiredString(args, "resource"));
        const current = await context.workspace.readResource(project, resource.id);
        const name = requiredString(args, "name");
        const step = args.step === undefined ? undefined : Number(args.step);
        const lines = current.content.split("\n");
        if (resource.type === "event-flow") {
          const line = lines.findIndex((entry) => /^\s*event\s+\S+/.test(entry) && entry.trim().split(/\s+/)[1] === name);
          if (line < 0) throw new Error(`No Event Flow event "${name}" found.`);
          if (lines[line].includes("messageRef")) throw new Error("The Event Flow event is already bound.");
          lines[line] += ` messageRef ${identity.id}`;
        } else {
          const ast = analyze(current.content).ast;
          const occurrence = ast && step !== undefined
            ? semanticMessagesOf(ast).find((entry) => entry.name === name && entry.step === step)
            : undefined;
          const semanticLine = occurrence ? occurrence.range.start.line + 1 : -1;
          if (semanticLine < 0 || step === undefined) throw new Error("Sequence binding requires an exact semantic name and step.");
          if (lines[semanticLine].includes("messageRef")) throw new Error("The Sequence occurrence is already bound.");
          lines[semanticLine] += ` messageRef ${identity.id}`;
        }
        const result = await context.workspace.updateResource(project, resource.id, { content: lines.join("\n") });
        return { text: `Bound ${name} to ${identity.id}.`, structured: { resource: resource.id, messageId: identity.id, result } };
      },
    },
    {
      definition: {
        name: "unbind_semantic_message",
        title: "Unbind semantic message occurrence",
        description: "Remove one explicit messageRef from a Sequence occurrence or Event Flow entity without deleting the shared identity.",
        inputSchema: objectSchema({ project: stringProp("Project id or name."), resource: stringProp("Resource id or path."), name: stringProp("Semantic message name."), step: numberProp("1-based Sequence message step; omit for Event Flow.") }, ["resource", "name"]),
        annotations: { ...write, title: "Unbind semantic message occurrence" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(optionalString(args, "project"));
        const resource = context.workspace.resolveResource(await context.workspace.index(project), requiredString(args, "resource"));
        const current = await context.workspace.readResource(project, resource.id);
        const lines = current.content.split("\n");
        const name = requiredString(args, "name");
        if (resource.type === "event-flow") {
          const line = lines.findIndex((entry) => /^\s*event\s+\S+/.test(entry) && entry.trim().split(/\s+/)[1] === name);
          if (line < 0) throw new Error(`No Event Flow event "${name}" found.`);
          lines[line] = lines[line].replace(/\s+messageRef\s+\S+/, "");
        } else {
          const ast = analyze(current.content).ast;
          const step = args.step === undefined ? undefined : Number(args.step);
          const occurrence = ast && step !== undefined ? semanticMessagesOf(ast).find((entry) => entry.name === name && entry.step === step) : undefined;
          if (!occurrence) throw new Error("Sequence unbinding requires an exact semantic name and step.");
          lines[occurrence.range.start.line + 1] = lines[occurrence.range.start.line + 1].replace(/\s+messageRef\s+\S+/, "");
        }
        const result = await context.workspace.updateResource(project, resource.id, { content: lines.join("\n") });
        return { text: `Unbound ${name}.`, structured: { resource: resource.id, result } };
      },
    },
    {
      definition: {
        name: "audit_documentation",
        title: "Audit documentation quality",
        description:
          "Find what the documentation is missing, not just what is invalid: broken in-project links, resources with no declared title, empty resources, resources nothing links to, a project with no prose overview, and documents too thin to be useful. Each finding carries a severity, a stable `code`, and a suggested action. Run it after `validate_project` when the goal is to improve a documentation set. Returns `{ project, summary, findings }`.",
        inputSchema: objectSchema({
          project: stringProp(
            "Project id or name. Optional when the workspace has exactly one project.",
          ),
        }),
        annotations: { ...readOnly, title: "Audit documentation quality" },
      },
      async run(args, context) {
        const project = await context.workspace.resolveProject(
          optionalString(args, "project"),
        );
        const audit = await context.workspace.audit(project);
        return { text: describeAudit(audit), structured: audit };
      },
    },
  ];
}

/** Look a tool up by name. */
export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((tool) => tool.definition.name === name);
}
