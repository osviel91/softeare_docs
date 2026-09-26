/**
 * Reusable DSL fragments offered by the editor's snippet menu.
 *
 * The two documentation languages have nothing in common below `title`, so each
 * has its own list rather than one list filtered at render time: inserting a
 * `participant` or an arrow into an event flow is a syntax error, and a menu
 * that offers it is worse than no menu. `SEQUENCE_SNIPPETS` stays the default,
 * so a caller that does not know the language still gets a usable menu.
 */

/** One insertable DSL fragment. */
export interface EditorSnippet {
  /** The menu row's title. */
  label: string;
  /** A one-line explanation shown beside the label. */
  hint: string;
  /** The text inserted at the caret. */
  text: string;
}

/** Fragments for the sequence-diagram language. */
export const SEQUENCE_SNIPPETS: EditorSnippet[] = [
  {
    label: "Title",
    hint: "name the diagram",
    text: "title My Diagram",
  },
  {
    label: "Participants",
    hint: "declare lifelines",
    text: "participant User\nparticipant API",
  },
  {
    label: "Actor",
    hint: "human lifeline",
    text: "actor User",
  },
  {
    label: "Labelled participant",
    hint: "stable id with a readable label",
    text: 'participant api as "Authentication Service"',
  },
  {
    label: "Alias",
    hint: "shorthand for a participant",
    text: "alias U = User",
  },
  {
    label: "Message",
    hint: "solid arrow with a head",
    text: "User ->> API: Request",
  },
  {
    label: "Semantic Event - Publish",
    hint: "mark an evidence-backed event publication",
    text: "API ->> API: EventName\nsemantic event publish EventName",
  },
  {
    label: "Semantic Event - Consume",
    hint: "mark an evidence-backed event consumption",
    text: "API ->> API: EventName\nsemantic event consume EventName",
  },
  {
    label: "Semantic Command - Dispatch",
    hint: "mark an evidence-backed command dispatch",
    text: "API ->> API: CommandName\nsemantic command dispatch CommandName",
  },
  {
    label: "Semantic Command - Consume",
    hint: "mark an evidence-backed command consumption",
    text: "API ->> API: CommandName\nsemantic command consume CommandName",
  },
  {
    label: "Response",
    hint: "dashed arrow with a head",
    text: "API -->> User: Response",
  },
  {
    label: "Self message",
    hint: "loop back onto one lifeline",
    text: "API ->> API: Validate token",
  },
  {
    label: "Note",
    hint: "callout on a lifeline",
    text: "note right of API : Detail",
  },
  {
    label: "Spanning note",
    hint: "covers several lifelines",
    text: "note over API,DB : Transaction boundary",
  },
  {
    label: "Multiline note",
    hint: "body closed by end note",
    text: "note right of API:\n  First line\n  Second line\nend note",
  },
  {
    label: "Note on message",
    hint: "attach to step number N",
    text: "note on 1 : Detail",
  },
  {
    label: "Activation",
    hint: "busy span on a lifeline",
    text: "activate API\nAPI ->> API: Work\ndeactivate API",
  },
  {
    label: "Inline activation",
    hint: "+ activates receiver, - deactivates sender",
    text: "User ->>+ API: Login\nAPI -->>- User: Token",
  },
  {
    label: "Loop",
    hint: "repeat a block",
    text: "loop retry up to 3 times\n  API ->> DB: Query\nend",
  },
  {
    label: "Alt / else",
    hint: "alternative branches",
    text: "alt user exists\n  API ->> DB: Load user\nelse user missing\n  API -->> User: 404\nend",
  },
  {
    label: "Opt",
    hint: "optional block",
    text: "opt cache hit\n  API -->> User: Cached\nend",
  },
  {
    label: "Par / and",
    hint: "parallel blocks",
    text: "par send email\n  API ->> Mail: Notify\nand write audit\n  API ->> DB: Log\nend",
  },
  {
    label: "Critical / option",
    hint: "critical region with fallback",
    text: "critical commit\n  API ->> DB: Commit\noption rollback\n  API ->> DB: Rollback\nend",
  },
  {
    label: "Break",
    hint: "interruption flow",
    text: "break request rejected\n  API -->> User: 400 Bad Request\nend",
  },
];

/**
 * Fragments for the event-flow language (`*.eventseq`).
 *
 * Deliberately one construct per entry, because a flow is built by naming
 * things and then wiring them: an author adds an event, a channel, a service,
 * then the publish/consume lines that connect them. The examples share one small
 * vocabulary (Kafka, orders, OrderCreated, OrderService, BillingService) so that
 * a handful of insertions already compose into a valid, warning-free document.
 */
export const EVENT_FLOW_SNIPPETS: EditorSnippet[] = [
  {
    label: "Title",
    hint: "name the flow",
    text: "title Order Processing",
  },
  {
    label: "Event",
    hint: "a fact others react to, with metadata",
    text: "event OrderCreated {\n  version: 1\n  domain: Orders\n}",
  },
  {
    label: "Event Flow Event",
    hint: "declare an event without inventing metadata",
    text: "event EventName",
  },
  {
    label: "Event Flow Command",
    hint: "declare a command with explicit kind",
    text: "event CommandName {\n  kind: command\n}",
  },
  {
    label: "Message Reference / Semantic Binding",
    hint: "bind only an established identity",
    text: "event EventName messageRef existing-identity-id",
  },
  {
    label: "Broker",
    hint: "infrastructure events travel through",
    text: "broker Kafka",
  },
  {
    label: "Topic",
    hint: "fan-out channel on a broker",
    text: "topic orders on Kafka",
  },
  {
    label: "Queue",
    hint: "channel that delivers to one consumer",
    text: "queue payments on Kafka",
  },
  {
    label: "Stream",
    hint: "ordered, replayable channel",
    text: "stream audit on Kafka",
  },
  {
    label: "Producer",
    hint: "a service that publishes",
    text: "producer OrderService",
  },
  {
    label: "Consumer",
    hint: "a service that subscribes",
    text: "consumer BillingService",
  },
  {
    label: "Service",
    hint: "declare a service without a role",
    text: "service PaymentService",
  },
  {
    label: "Publish",
    hint: "service-first publication",
    text: "OrderService publishes OrderCreated to orders",
  },
  {
    label: "Consume",
    hint: "service-first subscription",
    text: "BillingService consumes OrderCreated from orders",
  },
  {
    label: "Publish (verb first)",
    hint: "event-first spelling of the same edge",
    text: "publish OrderCreated from OrderService to orders",
  },
  {
    label: "Consume (verb first)",
    hint: "event-first spelling of the same edge",
    text: "consume OrderCreated by BillingService from orders",
  },
];
