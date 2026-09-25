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
/** URI of the canonical documentation guidance derived from D01. */
export const DOCUMENTATION_MODEL_URI =
  "sequencediagrams://guide/documentation-model";

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
  "This server turns an application's behaviour into durable documentation: sequence diagrams for interactions, event flows for event-driven architectures, and markdown for the prose that ties them together. The canonical documentation model is available at sequencediagrams://guide/documentation-model and is authoritative for representation choice; docs/documentation-model.md is its source.",
  "",
  "Work like this:",
  "1. Discover first: call list_projects, get_project_overview, list_resources, search_documentation, and read_resource/get_outline before writing anything.",
  "2. Classify each need: Sequence is one business/application flow and Event Flow represents asynchronous/event-driven causal behavior, but these are orthogonal projections, not mutually exclusive classifications. A Sequence may preserve ordered collaboration that includes asynchronous messages; add an Event Flow when the same evidence also exposes a meaningful causal chain with provenance, handlers, caused messages, and effects. Do not mechanically duplicate every Sequence. Markdown is a Note for cross-cutting rules and context. HTTP requests, synchronous calls, reverse-proxy routing, cron invocation, logs/telemetry, and infrastructure topology do not establish an Event Flow by themselves. A project may legitimately have no Event Flow documentation; do not force synchronous or structural behavior into it. Conceptual (structure) and Database (persistence) are future, unsupported representations; report those gaps instead of misusing another type.",
  "3. Compare existing semantic subjects, titles, paths, content, and metadata where the connected server exposes them. Update or propose against substantial overlap; create only genuinely missing supported resources.",
  "4. Plan before mutation. Prefer Change Proposals for substantial updates to existing resources, and do not treat analysis as permission to mutate canonical documentation.",
  "5. Read a resource's DSL reference before authoring (`sequencediagrams://reference/sequence-dsl`, `sequencediagrams://reference/event-flow-dsl`, or `sequencediagrams://reference/markdown`), use create_resource or update_resource only after the plan, validate proposed content with validate_source or validate_resource, inspect its diff/merge analysis where applicable, and use audit_documentation before review.",
  "",
  "Conventions that make the output good:",
  "- Evidence is observed, inferred, or unknown. Do not guess retries, transactions, delivery, idempotency, authorization, provenance, or failure behavior.",
  "- Use source references when the current representation supports them; never invent locations.",
  "- Write for the next engineer: labels and notes should say why, not restate the arrow.",
].join("\n");

/**
 * Concise operational guidance derived from docs/documentation-model.md.
 * Keep the full D01 specification in the repository rather than duplicating it
 * in MCP; this resource is the agent-sized, discoverable layer.
 */
export function documentationModelText(): string {
  return [
    "# Canonical documentation guidance",
    "",
    "Authoritative source: `docs/documentation-model.md`. This resource is a concise operational summary, not a second specification.",
    "",
    "## Choose a representation",
    "",
    "| Knowledge | Representation | Current MCP support |",
    "| --- | --- | --- |",
    "| One recognizable business/application execution | Sequence | supported (`kind: diagram`, `.seq`) |",
    "| Connected asynchronous causality/reaction | Event Flow | supported (`kind: event-flow`, `.eventseq`) |",
    "| Cross-cutting rules, decisions, or context | Note | supported (`kind: note`, `.md`) |",
    "| Structural/domain/architecture relationships | Conceptual | future; unsupported today |",
    "| Data/persistence relationships | Database | future; unsupported today |",
    "",
    "Sequence and Event Flow are orthogonal projections. Sequence preserves execution order and component collaboration; Event Flow preserves asynchronous causality, message provenance, handler responsibility, caused messages, and effects. The UpOne fan-out from `UpOneTransactionRaisedEvent` through handlers, commands, and persistence effects is a valid example for both views when the causal chain is meaningful. Do not mechanically duplicate every Sequence as an Event Flow.",
    "",
    "If Conceptual or Database is the correct representation, report an unsupported documentation gap. Do not force structural knowledge into Event Flow or persistence knowledge into Sequence. Capture a genuinely cross-cutting textual concern as a Note only when that is useful and honest.",
    "",
    "## Sequence",
    "",
    "Use one diagram per recognizable business/application flow. Bound it by independent actor/system intent and meaningful outcome, not by a file, class, endpoint, method, or architectural layer. Before creating one, identify the trigger, outcome, participating responsibility boundaries, and whether an existing diagram already covers it.",
    "",
    "A business Sequence may include asynchronous event interactions when they are part of the ordered collaboration. If those interactions expose a meaningful causal chain, consider an additional Event Flow rather than forcing execution and causality into one representation.",
    "",
    "Use annotations for rules, invariants, authorization, contracts, returned data, transaction boundaries, concurrency, idempotency, and important failure behavior. Do not narrate obvious calls.",
    "",
    "## Event Flow",
    "",
    "Event Flow represents asynchronous/event-driven causal behavior. HTTP requests, synchronous calls, reverse-proxy routing, cron invocation, logs/telemetry, and infrastructure topology do not establish an Event Flow by themselves. Synchronous HTTP routing is not an Event Flow. A project may legitimately contain no Event Flow documentation; do not force synchronous or structural behavior into it.",
    "",
    "Use one connected bounded event context, not one diagram per event or handler. Group events with the same domain capability, direct causal relationships, shared state transitions, strong producer/consumer continuity, or useful debugging continuity. Split semantically unrelated networks, not merely large graphs.",
    "",
    "## Assessment guidance",
    "",
    "INCOMPLETE means the representation and semantic boundary are correct, but important knowledge is missing. MISREPRESENTED means the representation's semantics do not match observed behavior. Synchronous HTTP routing represented as asynchronous Event Flow is MISREPRESENTED, not merely incomplete.",
    "",
    "When real asynchronous behavior exists, use `Event -> Handler/consumer -> Effects -> Resulting events` as an investigation heuristic, not a mandatory shape. The absence of an asynchronous event context is a valid result: say `No asynchronous event context was observed` rather than inventing Event Flow coverage. Topology (`publishes`/`consumes`) is not causality. Use explicit `handler`, `handled by`, `causes`, and `effect` lines; never infer handler outputs from service publications. Partial causal knowledge is valid, and unknown provenance is preferable to invented provenance. Commands and events share the generic message-name slot.",
    "",
    "For each important message, preserve an explicit `kind: event|command` when evidence supports it; commands and events remain one message-level concept. Document evidence-supported provenance (external, internal, or unknown) separately from initiation. Use `scheduled|external|manual|startup|unknown initiates <message>` when the root's origin is known; a scheduled internal command is valid. Do not infer initiation from producer topology or invent absent behavior, retry policy, or unsupported syntax.",
    "",
    "## Notes",
    "",
    "Use Notes for authorization models, cross-flow invariants, transaction guarantees, recovery behavior, deployment constraints, idempotency strategy, external assumptions, and cross-cutting business rules. Keep information local to an interaction, event, handler, or element as a diagram annotation. Use standalone Notes for knowledge spanning resources or deserving independent discovery.",
    "",
    "## Discover before authoring",
    "",
    "1. Inspect the repository and architecture.",
    "2. Discover business flows, event contexts, structural concepts, persistence boundaries, and cross-cutting rules.",
    "3. Inspect existing project documentation with `list_resources`, `get_outline`, `read_resource`, and `search_documentation` by semantic terms, representation, title, path, and exposed metadata. This stdio surface does not expose the server metadata operation; treat metadata as unavailable rather than guessing when it is absent.",
    "4. Compare coverage: existing, stale, missing, overlapping, and unsupported.",
    "5. Present a plan before mutation. Update or propose against overlapping existing resources; create only a genuinely missing supported resource.",
    "6. Validate content and inspect diffs/merge analysis before review.",
    "",
    "Treat claims as observed, inferred, or unknown. Important claims should be supported by source, configuration, schemas, tests, or authoritative documentation. Use trajectory/history when recent changes or provenance help explain apparent staleness; it is not required for every operation.",
    "",
    "Analysis does not grant mutation permission. Prefer Change Proposals for substantial updates to existing resources. Creating a genuinely missing resource uses the existing creation workflow; D02 does not invent proposals to create resources.",
  ].join("\n");
}

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
      "The language for `*.eventseq` files: topology declarations describe events,",
      "services, channels, publications, and subscriptions; optional causal lines",
      "explicitly connect events, handlers, effects, and resulting messages.",
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
    {
      uri: DOCUMENTATION_MODEL_URI,
      name: "documentation-model",
      title: "Canonical documentation guidance",
      description:
        "Agent-sized guidance derived from docs/documentation-model.md: representation choice, granularity, evidence, discovery, overlap, and proposal workflow.",
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
    case DOCUMENTATION_MODEL_URI:
      return documentationModelText();
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
