import { EVENT_FLOW_CONSTRUCTS } from "../../../src/language/dsl-reference";

export const EVENT_FLOW_DSL_URI = "seqdocs://reference/event-flow-dsl";

function eventFlowDslText(): string {
  return [
    "# Event Flow language",
    "",
    "The `*.eventseq` language supports topology, explicit causality, and evidence-backed failure/recovery semantics. Do not infer retry behavior from queues or asynchronous messaging; absent policy fields remain unknown.",
    "Read this before authoring an event flow.",
    "",
    ...EVENT_FLOW_CONSTRUCTS.flatMap((construct) => [
      `## ${construct.name}`,
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
      "",
    ]),
  ].join("\n");
}

export function registerMcpReferences(server: {
  registerResource: (
    name: string,
    uri: string,
    metadata: {
      title: string;
      description: string;
      mimeType: string;
    },
    read: (uri: URL) => Promise<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>,
  ) => unknown;
}): void {
  server.registerResource(
    "event-flow-dsl",
    EVENT_FLOW_DSL_URI,
    {
      title: "Event Flow language reference",
      description:
        "The supported event-flow topology and causal authoring syntax, with examples.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: eventFlowDslText() },
      ],
    }),
  );
}
