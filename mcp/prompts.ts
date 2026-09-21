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
              "",
              "Then:",
              "1. Inspect the system — the source tree, or what the user has told you — and decide the document set before creating files: one markdown overview, one sequence diagram per significant interaction, and an event flow per event-driven subsystem.",
              "2. Call `get_project_overview`; call `create_project` if the workspace has none.",
              `3. Read ${SEQUENCE_DSL_URI} before the first diagram, and ${EVENT_FLOW_DSL_URI} before the first event flow.`,
              "4. Create each document with `create_resource`, giving it a real title and a name that reads as an id (`refund-flow`, not `Untitled 2`).",
              "5. Show failure paths with `alt`/`else` and explain non-obvious steps with notes.",
              `6. Write the overview last, and link every document from it (\`[[Title]]\` or a stable resource:// id) — see ${MARKDOWN_URI}.`,
              "7. Run `validate_project` and fix every error, then `audit_documentation` and address the findings.",
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
              projectHint,
              arg(args, "focus") === undefined
                ? ""
                : `Concentrate on: ${arg(args, "focus")}.`,
              "",
              "Then:",
              "1. Call `get_project_overview` and `audit_documentation` to see what exists and what is missing.",
              "2. Fix every error first: broken links, invalid DSL, unknown participants.",
              "3. For each warning and suggestion, either fix it or explain why it is intentional.",
              "4. Read the documents that do exist and judge them as a reader would: does the overview explain the system and link its diagrams? Do the diagrams show failure paths? Do notes explain why a step happens?",
              "5. Use `update_resource` to improve text in place, and `create_resource` only for genuinely new documents. Link anything that is unreferenced.",
              `6. Re-read ${SEQUENCE_DSL_URI} if a diagram needs a construct you have not used.`,
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
              projectHint,
              "",
              `Read ${EVENT_FLOW_DSL_URI}, then call \`create_resource\` with \`kind: "event-flow"\`.`,
              "",
              "Requirements:",
              "- A `title`, then an `event` declaration per fact other services react to, with useful metadata (`version`, `domain`, `schema`).",
              "- `broker` and one `topic`/`queue`/`stream` declaration per channel, with `on <broker>`.",
              "- `producer`/`consumer`/`service` for every service you name — an undeclared name is a diagnostic.",
              "- One `publishes` edge per producer and one `consumes` edge per consumer, naming the channel.",
              "- Make fan-out and cascades explicit rather than implied: every competing consumer gets its own line.",
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
