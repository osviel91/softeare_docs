import { EVENT_FLOW_CONSTRUCTS } from "../../../src/language/dsl-reference";

export const EVENT_FLOW_DSL_URI = "seqdocs://reference/event-flow-dsl";

function eventFlowDslText(): string {
  return [
    "# Event Flow language",
    "",
    "The `*.eventseq` language supports topology, explicit causality, and evidence-backed failure/recovery semantics. Do not infer retry behavior from queues or asynchronous messaging; absent policy fields remain unknown.",
    "Read this before authoring an event flow.",
    "",
    "## Semantic authoring and progressive enrichment",
    "",
    "A SemanticMessageIdentity is a stable project-scoped architectural identity. Its human-readable name is not its identity: `messageRef` is the explicit binding. One identity may have many Sequence occurrences and Event Flow entities. Event and command are independent message kinds; publish, consume, and dispatch are occurrence operations. Use structured semantics only when evidence establishes asynchronous message behavior, never infer kind from a name suffix, and leave an occurrence valid and unbound when identity is not yet known.",
    "",
    "Before binding, call `list_semantic_messages`, `list_semantic_occurrences`, and `find_semantic_message_candidates`. Determine from evidence whether equal or similar names are the same architectural message; reuse an authoritative identity or call `create_semantic_message` with only name and kind, receive its server-generated id, then bind each exact occurrence and verify with `get_semantic_message`. Never invent a UUID. A cross-view message binding does not imply a `complementary-view` relationship. Create that relationship only when the Sequence and Event Flow are substantially the same behavior viewed through execution and causality.",
    "",
    "When improving legacy documentation, inspect first and report conservative enrichment candidates: unstructured message-like Sequence calls, structured but unbound occurrences, Event Flow entities without `messageRef`, missing useful descriptions/tags, prose-only retry/failure facts, and untyped complementary projections. Apply only evidenced targeted changes and validate afterward; do not rewrite the project automatically.",
    "",
    "New resources normally include a concise architectural description and useful evidence-backed tags. Notes/details are selective and preserve conditions, uncertainty, constraints, rationale, boundaries, transformations, delivery/idempotency/retry facts, or other information not represented by the diagram. Do not invent metadata.",
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
