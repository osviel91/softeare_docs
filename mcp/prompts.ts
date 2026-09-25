/**
 * Reusable workflow prompts.
 *
 * MCP prompts are user-controlled: a client surfaces them as slash commands or
 * menu entries, and the user picks one. They are the right place for the
 * *opinionated* part of documentation work — what to inspect, which document to
 * create first, what a good diagram contains — because that guidance is
 * authored once here instead of being re-derived by every model on every task.
 *
 * Each prompt is a single user message that names the tools and resources to
 * use, so following it produces a coherent documentation set rather than a pile
 * of unlinked diagrams.
 */
import type { PromptDefinition, PromptMessage } from "./protocol";
import {
  DOCUMENTATION_MODEL_URI,
  DOCUMENTING_GUIDE_URI,
  EVENT_FLOW_DSL_URI,
  MARKDOWN_URI,
  SEQUENCE_DSL_URI,
} from "./reference";

/** A prompt's resolved content. */
export interface ResolvedPrompt {
  description: string;
  messages: PromptMessage[];
}

/** One user text message, which is all these prompts need. */
function userMessage(text: string): PromptMessage {
  return { role: "user", content: { type: "text", text } };
}

/** Read an argument, treating a blank string as absent. */
function arg(
  args: Record<string, string> | undefined,
  name: string,
): string | undefined {
  const value = args?.[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** The prompts the server advertises. */
export function promptDefinitions(): PromptDefinition[] {
  return [
    {
      name: "document-application",
      title: "Document an application",
      description:
        "Produce or extend a documentation set for a system: an overview document, a sequence diagram per key interaction, and event flows where the architecture is event-driven.",
      arguments: [
        {
          name: "project",
          description:
            "Project to write into; defaults to the only project when there is one.",
        },
        {
          name: "system",
          description:
            "The system or feature to document, in the user's words.",
        },
        {
          name: "scope",
          description:
            "Optional boundary, e.g. 'only the payment path' or 'include failure modes'.",
        },
      ],
    },
    {
      name: "improve-documentation",
      title: "Improve existing documentation",
      description:
        "Audit a project, then fix the findings: broken links, untitled or empty resources, unlinked documents, and diagrams that only show the happy path.",
      arguments: [
        {
          name: "project",
          description:
            "Project to audit; defaults to the only project when there is one.",
        },
        {
          name: "focus",
          description:
            "Optional area to concentrate on, e.g. 'the event flows'.",
        },
      ],
    },
    {
      name: "diagram-interaction-flow",
      title: "Diagram one interaction flow",
      description:
        "Turn a described flow (a request path, a user journey, a failure case) into one focused sequence diagram with notes on the non-obvious decisions.",
      arguments: [
        {
          name: "flow",
          description: "The interaction to draw, in the user's words.",
          required: true,
        },
        {
          name: "project",
          description:
            "Project to write into; defaults to the only project when there is one.",
        },
      ],
    },
    {
      name: "model-event-driven-architecture",
      title: "Model an event-driven architecture",
      description:
        "Turn a broker topology (events, producers, consumers, channels) into an event flow document that lays out fan-out and causal chains.",
      arguments: [
        {
          name: "system",
          description: "The event-driven system to model.",
          required: true,
        },
        {
          name: "project",
          description:
            "Project to write into; defaults to the only project when there is one.",
        },
      ],
    },
  ];
}

/** Resolve one prompt by name, substituting its arguments. */
export function resolvePrompt(
  name: string,
  args?: Record<string, string>,
): ResolvedPrompt | null {
  const project = arg(args, "project");
  const projectHint =
    project === undefined
      ? "Omit `project` on the tool calls unless the workspace has more than one project; the tools resolve the only project for you."
      : `Use project \`${project}\` on every tool call.`;

  switch (name) {
    case "document-application": {
      const system =
        arg(args, "system") ?? "the application the user is working on";
      const scope = arg(args, "scope");
      return {
        description: "Document an application end to end.",
        messages: [
          userMessage(
            [
              `Document ${system} with this project's documentation tools.`,
              scope === undefined ? "" : `Boundary: ${scope}.`,
              projectHint,
              "",
              `First read the writing guide at ${DOCUMENTING_GUIDE_URI}.`,
              `Read the canonical representation guidance at ${DOCUMENTATION_MODEL_URI}; it is derived from docs/documentation-model.md.`,
              "",
              "Then:",
              "1. Discover the source and existing documentation before authoring: list projects/resources, inspect outlines and content, and search semantic terms.",
              "2. Classify needs as business flows, event contexts, Notes, or unsupported Conceptual/Database gaps. Do not force unsupported representations into available types.",
              "3. Compare existing coverage and present a plan identifying existing, stale, missing, overlapping, and unsupported documentation.",
              `4. Read ${SEQUENCE_DSL_URI} before a Sequence and ${EVENT_FLOW_DSL_URI} before an Event Flow; create only genuinely missing supported resources.`,
              "5. Prefer Change Proposals for substantial updates to existing resources; use direct creation only for genuinely new resources under current permissions.",
              "6. Show failure paths with `alt`/`else`, explain non-obvious steps with notes, validate, and inspect diffs before review.",
              `7. Write the overview last, and link every document from it (\`[[Title]]\` or a stable resource:// id) — see ${MARKDOWN_URI}.`,
              "",
              "Report what you created, what you could not determine from the available information, and which links or diagrams still need a human's input.",
            ]
              .filter((line) => line !== "")
              .join("\n"),
          ),
        ],
      };
    }

    case "improve-documentation":
      return {
        description: "Audit and improve a project's documentation.",
        messages: [
          userMessage(
            [
              "Improve the documentation in this workspace.",
              `Read ${DOCUMENTATION_MODEL_URI} before deciding whether a finding is a Sequence, Event Flow, Note, or unsupported Conceptual/Database gap.`,
              projectHint,
              arg(args, "focus") === undefined
                ? ""
                : `Concentrate on: ${arg(args, "focus")}.`,
              "",
              "Then:",
              "1. Call `get_project_overview`, `list_resources`, `search_documentation`, and `audit_documentation` to see what exists and what is missing.",
              "2. Read existing resources before changing them; identify stale and overlapping coverage rather than silently creating duplicates.",
              "3. Fix every error first: broken links, invalid DSL, unknown participants.",
              "4. For each warning and suggestion, either fix it or explain why it is intentional; report unsupported structural/persistence gaps instead of misrepresenting them.",
              "5. Prefer a Change Proposal for substantial updates to existing resources. Use `update_resource` only when the current workflow explicitly calls for direct mutation, and `create_resource` only for genuinely new resources.",
              `6. Re-read ${SEQUENCE_DSL_URI} or ${EVENT_FLOW_DSL_URI} if a supported diagram needs a construct you have not used.`,
              "",
              "Report each change as before → after, and list anything that needs information you do not have.",
            ]
              .filter((line) => line !== "")
              .join("\n"),
          ),
        ],
      };

    case "diagram-interaction-flow": {
      const flow = arg(args, "flow");
      if (flow === undefined) return null;
      return {
        description: "Diagram one interaction flow.",
        messages: [
          userMessage(
            [
              `Draw this interaction as a sequence diagram: ${flow}`,
              `First read ${DOCUMENTATION_MODEL_URI}; confirm this is one business/application flow and search for an existing covering resource before creating anything.`,
              projectHint,
              "",
              `Read ${SEQUENCE_DSL_URI}, then call \`create_resource\` with \`kind: "diagram"\`.`,
              "",
              "Requirements:",
              "- A `title`, and every participant declared before the first message.",
              '- Participant names that match the real components; use `actor` for a person and `as "Label"` when the readable name differs from the id.',
              "- The order of messages exactly as it happens, with responses drawn dashed (`-->>`).",
              "- `alt`/`else` for the failure or rejection path when one exists.",
              "- A note on each non-obvious decision (a retry, a timeout, why a call is asynchronous).",
              "",
              "Call `validate_resource` and fix any diagnostics, then `render_diagram` to confirm it draws.",
            ].join("\n"),
          ),
        ],
      };
    }

    case "model-event-driven-architecture": {
      const system = arg(args, "system");
      if (system === undefined) return null;
      return {
        description: "Model an event-driven architecture as an event flow.",
        messages: [
          userMessage(
            [
              `Model the event-driven architecture of ${system} as an event flow document.`,
              `First read ${DOCUMENTATION_MODEL_URI}; inspect existing event documentation and plan a bounded causal context before creating anything.`,
              projectHint,
              "",
              `Read ${EVENT_FLOW_DSL_URI}, then call \`create_resource\` with \`kind: "event-flow"\`.`,
              "",
              "Requirements:",
              "- A `title`, then an `event` declaration per fact other services react to, with useful metadata (`version`, `domain`, `schema`). Record external/internal/unknown provenance only when evidence supports it.",
              "- `broker` and one `topic`/`queue`/`stream` declaration per channel, with `on <broker>`.",
              "- `producer`/`consumer`/`service` for every service you name — an undeclared name is a diagnostic.",
              "- One `publishes` edge per producer and one `consumes` edge per consumer, naming the channel.",
              "- Make fan-out and cascades explicit rather than implied: every competing consumer gets its own line.",
              "- Think through Event -> handler/consumer -> effects -> resulting events. Use current syntax only; put unsupported handler/effect details in honest annotations or report the gap.",
              "",
              "Then call `validate_project` and fix every error; the event-driven checks (an event with no producer, an unknown service, an unused channel) are exactly the review a reader would do.",
            ].join("\n"),
          ),
        ],
      };
    }

    default:
      return null;
  }
}
