/**
 * The context the server hands a model before it touches a document.
 *
 * MCP resources are the protocol's "application-driven" half: unlike a tool,
 * which the model chooses, a resource is material the host can attach to the
 * conversation. Everything static and expensive to rediscover lives here —
 * the two DSL references, the markdown dialect, and two guides (how to document
 * an application, and how this server's tools fit together). The DSL references
 * are generated from `src/language/dsl-reference.ts`, the same data the editor's
 * Docs panel renders, so the reference a model reads cannot drift behind the
 * grammar the parser implements.
 */
import {
  DSL_CONSTRUCTS,
  EVENT_FLOW_CONSTRUCTS,
  type DslConstruct,
} from "../src/language/dsl-reference";
import type {
  ResourceDefinition,
  ResourceTemplateDefinition,
} from "./protocol";

/** URI of the sequence-diagram language reference. */
export const SEQUENCE_DSL_URI = "sequencediagrams://reference/sequence-dsl";
/** URI of the event-flow language reference. */
export const EVENT_FLOW_DSL_URI = "sequencediagrams://reference/event-flow-dsl";
/** URI of the markdown dialect reference. */
export const MARKDOWN_URI = "sequencediagrams://reference/markdown";
/** URI of the "document an application" guide. */
export const DOCUMENTING_GUIDE_URI =
  "sequencediagrams://guide/documenting-an-application";
/** URI of the tool-workflow guide. */
export const WORKFLOW_GUIDE_URI = "sequencediagrams://guide/tool-workflow";

/** The URI template for reading a project resource directly. */
export const PROJECT_RESOURCE_TEMPLATE =
  "sequencediagrams://project/{project}/resource/{path}";

/**
 * The `instructions` field of `initialize`/`server/discover`.
 *
 * The specification calls this "natural-language guidance for LLMs on how to
 * use this server effectively", and it is the first thing a client shows the
 * model — so it states the workflow and the one rule (validate before you
 * trust) rather than describing the transport.
 */
export const SERVER_INSTRUCTIONS = [
  "This server turns an application's behaviour into durable documentation: sequence diagrams for interactions, event flows for event-driven architectures, and markdown for the prose that ties them together. It is the same engine Software Docs Manager uses, so anything written here opens in the app unchanged.",
  "",
  "Work like this:",
  "1. Call get_project_overview (or list_projects) before writing anything. It reports what already exists, which symbols are in play, and what is currently wrong.",
  "2. Read a resource's DSL reference before authoring a new language construct: resources sequencediagrams://reference/sequence-dsl, sequencediagrams://reference/event-flow-dsl, and sequencediagrams://reference/markdown.",
  "3. Create or update documents with create_resource and update_resource. Pass a title; the server prepends one when the text declares none.",
  "4. Validate what you wrote with validate_source (ad-hoc text) or validate_resource, and fix every error before moving on. Warnings are worth a look: an unused participant or a channel nobody consumes usually means the model is incomplete.",
  "5. Prefer linking documents together. A markdown overview that links each diagram with [[Title]] (or a relative link, or a stable resource:// id) is what makes the project navigable; audit_documentation lists what is not linked.",
  "",
  "Conventions that make the output good:",
  "- A resource is one idea. Do not put every flow in one diagram.",
  "- Name participants after real components (UserService, Postgres, Kafka), and declare them once per document.",
  "- Use a stable id when you link: resource://diagram-checkout survives renaming the file.",
  "- Write for the next engineer: labels and notes should say why, not restate the arrow.",
].join("\n");

/** Render one language's constructs as markdown. */
function constructsToMarkdown(
  heading: string,
  intro: string,
  constructs: DslConstruct[],
): string {
  const entries = constructs.map((construct) =>
    [
      `### ${construct.name}`,
      "",
      "```text",
      construct.syntax,
      "```",
      "",
      construct.summary,
      "",
      "Example:",
      "",
      "```text",
      construct.example,
      "```",
    ].join("\n"),
  );
  return [`# ${heading}`, "", intro, "", ...entries].join("\n\n");
}

/** The sequence-diagram reference as markdown. */
export function sequenceDslText(): string {
  return constructsToMarkdown(
    "Sequence diagram language",
    [
      "The language these tools write for `*.seq` files. Statements are one per",
      "line; a message's arrow spelling carries its semantics. Declare every",
      "participant before the first message, and give the diagram a `title`.",
    ].join(" "),
    DSL_CONSTRUCTS,
  );
}

/** The event-flow reference as markdown. */
export function eventFlowDslText(): string {
  return constructsToMarkdown(
    "Event flow language",
    [
      "The language for `*.eventseq` files: it documents an event-driven system",
      "as declarations of events, services and channels, then the publish and",
      "consume edges between them. Both edge spellings parse to the same model.",
    ].join(" "),
    EVENT_FLOW_CONSTRUCTS,
  );
}

/** The markdown dialect reference as markdown. */
export function markdownReferenceText(): string {
  return [
    "# Markdown documents",
    "",
    "Documents are `*.md` files rendered by the project's own markdown implementation (no third-party parser). All user text is escaped before it becomes markup.",
    "",
    "## Supported syntax",
    "",
    "- ATX headings (`#` … `######`). The first heading is the document's title, and headings become the outline and the project index.",
    "- Paragraphs, unordered (`-`, `*`, `+`) and ordered lists, and block quotes.",
    "- Pipe tables: `| a | b |` with a `| --- | --- |` separator row.",
    "- Fenced code blocks (``` or ~~~) and inline `code`.",
    "- Emphasis (`*italic*`, `_italic_`), strong (`**bold**`), and strikethrough (`~~text~~`).",
    "- Images: `![alt](path/to/image.png)`.",
    "- Links: `[text](url)`.",
    "",
    "## Linking inside a project",
    "",
    "A link may address another resource in the same project in any of these forms:",
    "",
    "- A wiki-link by display title: `[[Payment flow]]`.",
    "- A relative path: `[Payment flow](../diagrams/payment.seq)`.",
    "- A stable id, which survives renaming and moving: `resource://diagram-payment-flow`, `diagram://diagram-payment-flow`, `eventflow://flow-order-processing`, `doc://doc-architecture`.",
    "",
    "An external URL (for example `https://example.com`) is left alone and is never reported as broken. An unresolved in-project link is a project error.",
    "",
    "## Embedding a diagram",
    "",
    "`{{diagram:resource-id}}` renders that sequence diagram inside the document; `{{eventflow:resource-id}}` does the same for an event flow. Both accept the resource's stable id (preferred) or its title/path.",
    "",
    "## What the audit looks for",
    "",
    "A document that links its diagrams, starts with a heading, and explains *why* the flow exists will pass `audit_documentation` cleanly. A document that exists but is linked from nowhere is reported as a gap.",
  ].join("\n");
}

/** The guide to documenting an application end to end. */
export function documentingGuideText(): string {
  return [
    "# Documenting an application",
    "",
    "A useful documentation set answers four questions: what the pieces are, how they talk, what can go wrong, and how the system evolved. The tools here cover the first three directly and the fourth through version history in the app.",
    "",
    "## 1. Establish the project",
    "",
    "Call `list_projects`. If the workspace has no project for this system, call `create_project` with a short name (`Payments`, `Checkout`). A project is a subdirectory of the workspace, and each of its files is a resource with a stable id recorded in `project.json`.",
    "",
    "## 2. Survey before you draw",
    "",
    "Read the codebase (or the user's description) and call `get_project_overview`. Then decide the documents before creating them — a documentation set that grows file-by-file drifts; one planned up front does not.",
    "",
    "A dependable shape:",
    "",
    "- One markdown overview (`architecture.md`) naming the system, its boundaries, and the diagrams below.",
    "- One sequence diagram per significant interaction (checkout, login, payment capture, refund).",
    "- One event flow per event-driven subsystem, if the architecture has one.",
    "- Notes inside diagrams for the non-obvious decisions — a timeout, a retry, why a step exists.",
    "",
    "## 3. Draw interactions",
    "",
    'Read `sequencediagrams://reference/sequence-dsl` first. Then create each diagram with `create_resource` and `kind: "diagram"`:',
    "",
    "```text",
    "title Checkout",
    "",
    "actor Customer",
    "participant CheckoutAPI",
    "participant PaymentService",
    "participant Postgres",
    "",
    "Customer ->> CheckoutAPI: Submit cart",
    "CheckoutAPI ->> PaymentService: Authorize payment",
    "PaymentService ->> Postgres: Record authorization",
    "PaymentService -->> CheckoutAPI: Authorized",
    "note right of PaymentService: Idempotency key from the cart id",
    "CheckoutAPI -->> Customer: Order confirmed",
    "```",
    "",
    "Model the failure path too (`alt`, `else`) — a diagram that only shows the happy path documents half the system.",
    "",
    "## 4. Model events",
    "",
    "Read `sequencediagrams://reference/event-flow-dsl`, then create an `event-flow`:",
    "",
    "```text",
    "title Order Processing",
    "",
    "event OrderCreated {\n  version: 2\n  domain: Orders\n}",
    "broker Kafka",
    "topic orders on Kafka",
    "producer OrderService",
    "consumer BillingService",
    "",
    "OrderService publishes OrderCreated to orders",
    "BillingService consumes OrderCreated from orders",
    "```",
    "",
    "Declare every service you name, so the index can flag an unknown one. Add metadata (`version`, `domain`, `schema`) — it is what a reader needs to consume the event correctly.",
    "",
    "## 5. Tie it together and verify",
    "",
    "- In the overview, link every document: `[[Checkout]]`, `[[Order Processing]]`, or a stable `resource://` id.",
    "- Run `validate_project` and fix every error.",
    "- Run `audit_documentation`; work through the findings. Unreferenced resources and untitled documents are the two that most often hide real gaps.",
    "- Render a diagram with `render_diagram` when you want to check it visually.",
    "",
    "## 6. Keep it honest",
    "",
    'Update the document in the same change as the code. `find_references` answers "where is this component documented?", and renaming a participant through the app\'s semantic rename keeps every mention consistent. A diagram that disagrees with the system is worse than no diagram.',
  ].join("\n");
}

/** The guide to this server's tool surface and a worked workflow. */
export function workflowGuideText(): string {
  return [
    "# Tool workflow",
    "",
    "The tools fall into four groups.",
    "",
    "## Orient",
    "",
    "- `list_projects` — projects in the workspace, with resource and diagnostic counts.",
    "- `create_project` — add a project (a workspace subdirectory).",
    "- `get_project_overview` — one project's counts, symbols by kind, and resources. The right first call.",
    "- `list_resources` — every resource with its stable id, path, type, title, and shape metrics.",
    "",
    "## Read",
    "",
    "- `read_resource` — the full text of one resource, by id, path, file name, or title.",
    "- `get_outline` — the structural tree of a diagram (title, participants, flow, fragments) or a document's headings.",
    "- `search_documentation` — text search across a project or the workspace; scopes: `kind:diagram`, `kind:note`, `project:Name`, `participant:Name`.",
    "- `find_references` — every declaration and usage of a symbol name in a project.",
    "",
    "## Write",
    "",
    "- `create_resource` — a diagram, event flow, or markdown document. `title` is prepended when the text declares none; `overwrite: true` replaces an existing file.",
    "- `update_resource` — `replace`, `append`, or `prepend` a resource's text.",
    "- `rename_resource` — move a file, keeping the stable id so links survive.",
    "- `delete_resource` — requires `confirm: true`.",
    "",
    "## Check",
    "",
    "- `validate_source` — validate text you have not written yet (the self-correction loop).",
    "- `validate_resource` / `validate_project` — diagnostics for one resource or the whole project.",
    "- `render_diagram` — the SVG for a diagram or event flow; returns the markup, or writes it to a workspace-relative path.",
    "- `audit_documentation` — documentation gaps: broken links, untitled or empty resources, resources nothing links to, a project with no prose, and thin documents.",
    "",
    "## Copy-paste loop",
    "",
    "```text",
    'get_project_overview { project: "Payments" }',
    'create_resource { project: "Payments", kind: "diagram", name: "refund-flow",',
    '                  title: "Refund flow", content: "..." }',
    'validate_resource { project: "Payments", resource: "refund-flow" }',
    'audit_documentation { project: "Payments" }',
    "```",
  ].join("\n");
}

/** Every static resource the server advertises. */
export function staticResources(): ResourceDefinition[] {
  return [
    {
      uri: SEQUENCE_DSL_URI,
      name: "sequence-dsl",
      title: "Sequence diagram language reference",
      description:
        "Every construct the *.seq language supports, with syntax and examples. Read before authoring a diagram.",
      mimeType: "text/markdown",
    },
    {
      uri: EVENT_FLOW_DSL_URI,
      name: "event-flow-dsl",
      title: "Event flow language reference",
      description:
        "Every construct the *.eventseq language supports, with syntax and examples. Read before authoring an event flow.",
      mimeType: "text/markdown",
    },
    {
      uri: MARKDOWN_URI,
      name: "markdown-dialect",
      title: "Markdown dialect and project linking",
      description:
        "The markdown the project renders, and how to link or embed another resource.",
      mimeType: "text/markdown",
    },
    {
      uri: DOCUMENTING_GUIDE_URI,
      name: "documenting-an-application",
      title: "Guide: documenting an application",
      description:
        "A workflow for turning an application's behaviour into a navigable documentation set.",
      mimeType: "text/markdown",
    },
    {
      uri: WORKFLOW_GUIDE_URI,
      name: "tool-workflow",
      title: "Guide: tool workflow",
      description:
        "What each tool does and a worked create-validate-audit loop.",
      mimeType: "text/markdown",
    },
  ];
}

/** Resource templates advertised to clients that support parameterised reads. */
export function resourceTemplates(): ResourceTemplateDefinition[] {
  return [
    {
      uriTemplate: PROJECT_RESOURCE_TEMPLATE,
      name: "project-resource",
      title: "A project document",
      description:
        "One resource in a project: its DSL source or markdown. Same content as read_resource.",
      mimeType: "text/plain",
    },
  ];
}

/** The text of a static resource, or `null` when the URI is not one of ours. */
export function staticResourceText(uri: string): string | null {
  switch (uri) {
    case SEQUENCE_DSL_URI:
      return sequenceDslText();
    case EVENT_FLOW_DSL_URI:
      return eventFlowDslText();
    case MARKDOWN_URI:
      return markdownReferenceText();
    case DOCUMENTING_GUIDE_URI:
      return documentingGuideText();
    case WORKFLOW_GUIDE_URI:
      return workflowGuideText();
    default:
      return null;
  }
}

/**
 * Parse a `sequencediagrams://project/{project}/resource/{path}` URI.
 *
 * The path may contain `/` (a project can nest directories), so only the
 * `project` segment is bounded; the rest of the URI is the resource path.
 */
export function parseProjectResourceUri(
  uri: string,
): { project: string; path: string } | null {
  const prefix = "sequencediagrams://project/";
  if (!uri.startsWith(prefix)) return null;
  const rest = uri.slice(prefix.length);
  const marker = "/resource/";
  const at = rest.indexOf(marker);
  if (at <= 0) return null;
  const project = decodeURIComponent(rest.slice(0, at));
  const path = decodeURIComponent(rest.slice(at + marker.length));
  if (project === "" || path === "") return null;
  return { project, path };
}
