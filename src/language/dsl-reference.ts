/**
 * The hand-written reference for the two documentation languages.
 *
 * The data lives here rather than inside the "Docs" React view so that the one
 * description of the grammars can be reused by everything that needs to explain
 * them: the editor's reference panel, the tests that guard each documented
 * keyword against the real lexer/parser, and the MCP server's `reference`
 * resources. Presentation is the caller's business — this module is plain data
 * with no DOM and no React, so it can be imported from a browser bundle and a
 * Node process alike.
 *
 * Keeping it as data is what lets `DslReference.test.tsx` assert that a
 * construct cannot be documented without being implemented.
 */

/** One documented construct. */
export interface DslConstruct {
  /** The construct's name, shown as the heading. */
  name: string;
  /** The grammar in shorthand, shown as code. */
  syntax: string;
  /** One sentence on what it does. */
  summary: string;
  /** A concrete snippet the user can copy. */
  example: string;
}

/** Every construct the DSL currently supports. */
export const DSL_CONSTRUCTS: DslConstruct[] = [
  {
    name: "Title",
    syntax: "title <text>",
    summary:
      "The diagram's name and heading. It may appear on any line (at most one per diagram); the explorer and tab bar show it instead of the file name.",
    example: "title Authentication Flow",
  },
  {
    name: "Participant",
    syntax: "participant <id> [as <label>]",
    summary:
      "Declares a lifeline. Participants must be declared before any message, and their order controls left-to-right placement. `as` gives the lifeline a human-readable label while messages keep using the stable id.",
    example: 'participant auth as "Authentication Service"',
  },
  {
    name: "Actor",
    syntax: "actor <id> [as <label>]",
    summary:
      "Like a participant, but drawn as a human figure — for the person or role that starts the flow. Actors share the same lifeline and message rules as participants.",
    example: 'actor user as "End User"',
  },
  {
    name: "Alias",
    syntax: "alias <shorthand> = <participant>",
    summary:
      "A second name for a declared participant. Aliases may not chain, and the target must already exist.",
    example: "participant User\nalias U = User",
  },
  {
    name: "Message",
    syntax: "<from> <arrow> <to> [: label]",
    summary:
      "An arrow between two lifelines, labelled optionally (the label may be empty). The arrow spelling chooses the line style and the ending; see Arrow styles. When both endpoints name the same participant the message is drawn as a loop back onto that lifeline.",
    example: "User ->> API: Login",
  },
  {
    name: "Arrow styles",
    syntax: "->  -->  ->>  -->>  -x  --x  -)  --)  <<->>  <<-->>",
    summary:
      "A solid or dashed line (`--` adds the dash) ending in a filled arrowhead (`->`, `-->`), the same shapes written with a double chevron (`->>`, `-->>`), a cross for a failed delivery (`-x`, `--x`), an open async chevron (`-)`, `--)`), or heads at both ends (`<<->>`, `<<-->>`). Every message line points somewhere.",
    example:
      "A ->> B: Request\nB --> A: Reply\nA -) Queue: Publish event\nA -x B: Failed",
  },
  {
    name: "Note",
    syntax: "note left|right of <participant> : <text>",
    summary:
      "A callout attached to a lifeline as a bullet; click the bullet to expand or collapse its text. `note over <participant> : <text>` centers it on one lifeline, and `note over : <text>` spans the whole diagram.",
    example: "note right of API : Reads from cache",
  },
  {
    name: "Spanning note",
    syntax: "note over <participant>, <participant> : <text>",
    summary:
      "A note that covers several lifelines, drawn as one box from the first named participant to the last.",
    example: "note over API,DB : Transaction boundary",
  },
  {
    name: "Multiline note",
    syntax: "note <placement> <participant>:\n  <line>\n  <line>\nend note",
    summary:
      "When nothing follows the `:`, the note body runs until `end note`, one line per row of the expanded box.",
    example: "note right of API:\nValidate JWT\nCheck expiration\nend note",
  },
  {
    name: "Note on a message",
    syntax: "note on <number> : <text>",
    summary:
      "Attaches the note to a single message by the step number the diagram prints in its circle (1 is the first message in source order, counting calls and responses). The bullet sits under that arrow and the box hangs below it. Multiline form: end with `end note`.",
    example: "User ->> API: Login\nnote on 1 : Retries twice on timeout",
  },
  {
    name: "Activation",
    syntax: "activate <participant> / deactivate <participant>",
    summary:
      "Draws a bar over a lifeline for the span in which that participant is working. Bars nest, and one left open runs to the end of the diagram.",
    example: "activate API\nAPI ->> API: Work\ndeactivate API",
  },
  {
    name: "Inline activation",
    syntax: "<from> <arrow>+ <to> / <from> <arrow>- <to>",
    summary:
      "A `+` right after the arrow activates the receiver at that row; a `-` deactivates the sender. Inline suffixes nest exactly like the explicit statements.",
    example: "User ->>+ API: Login\nAPI -->>- User: Token",
  },
  {
    name: "Loop",
    syntax: "loop <label>\n  <statements>\nend",
    summary:
      "A `loop` fragment frames the statements it contains and labels the frame. Fragments nest inside each other.",
    example: "loop retry up to 3 times\n  Client ->> API: Request\nend",
  },
  {
    name: "Alt / else",
    syntax:
      "alt <condition>\n  <statements>\nelse <condition>\n  <statements>\nend",
    summary:
      "Alternative branches, separated by `else`. Each branch gets its own labelled region inside one frame.",
    example:
      "alt user exists\n  API ->> DB: Load user\nelse user missing\n  API -->> Client: 404\nend",
  },
  {
    name: "Opt",
    syntax: "opt <label>\n  <statements>\nend",
    summary:
      "An optional block: the statements run only when the condition holds.",
    example: "opt cache hit\n  API -->> Client: Cached\nend",
  },
  {
    name: "Par / and",
    syntax: "par <label>\n  <statements>\nand <label>\n  <statements>\nend",
    summary:
      "Parallel regions, separated by `and`, all of which may run at once.",
    example:
      "par send email\n  API ->> Mail: Notify\nand write audit\n  API ->> DB: Log\nend",
  },
  {
    name: "Critical / option",
    syntax:
      "critical <label>\n  <statements>\noption <label>\n  <statements>\nend",
    summary:
      "A critical region with alternative handling, separated by `option`.",
    example:
      "critical commit\n  API ->> DB: Commit\noption rollback\n  API ->> DB: Rollback\nend",
  },
  {
    name: "Break",
    syntax: "break <label>\n  <statements>\nend",
    summary:
      "An interruption flow: the statements describe what breaks out of the enclosing fragment.",
    example: "break request rejected\n  API -->> Client: 400\nend",
  },
  {
    name: "Comment",
    syntax: "// <text>",
    summary: "Everything from `//` to the end of the line is ignored.",
    example: "// participants first",
  },
];

/** Every construct the event-flow language (`*.eventseq`) currently supports. */
export const EVENT_FLOW_CONSTRUCTS: DslConstruct[] = [
  {
    name: "Title",
    syntax: "title <text>",
    summary:
      "The flow's name and heading; the explorer and the tab bar show it instead of the file name.",
    example: "title Order Processing",
  },
  {
    name: "Event",
    syntax: "event <name> [{\n  <key>: <value>\n}]",
    summary:
      "A fact other services react to. The optional block holds arbitrary `key: value` metadata — version, domain, schema, correlation key, partition key — so the model is not limited to a fixed set of fields.",
    example: "event OrderCreated {\n  version: 2\n  domain: Orders\n}",
  },
  {
    name: "Broker",
    syntax: "broker <name>",
    summary:
      "The infrastructure events travel through. A channel may name the broker that hosts it with `on`.",
    example: "broker Kafka",
  },
  {
    name: "Channel",
    syntax:
      "topic <name> [on <broker>]\nqueue <name> [on <broker>]\nstream <name> [on <broker>]",
    summary:
      "The three channel kinds. A topic fans out to every subscriber, a queue delivers to one consumer, and a stream is ordered and replayable. The kind is documentation rather than decoration, and an unused channel is reported.",
    example:
      "topic orders on Kafka\nqueue payments on Kafka\nstream audit on Kafka",
  },
  {
    name: "Producer / consumer / service",
    syntax: "producer <name>\nconsumer <name>\nservice <name>",
    summary:
      "Declares a service. `producer` and `consumer` are role hints for the reader; `service` is role-neutral. Naming a service in a publish/consume line without declaring it is reported as an unknown service.",
    example:
      "producer OrderService\nconsumer BillingService\nservice PaymentService",
  },
  {
    name: "Publication",
    syntax: "<service> publishes <event> [to <channel>]",
    summary:
      "Wires a service to an event it produces. Several services may publish the same event.",
    example: "OrderService publishes OrderCreated to orders",
  },
  {
    name: "Subscription",
    syntax: "<service> consumes <event> [from <channel>]",
    summary:
      "Wires a service to an event it reacts to. Every subscription for one event is one consumer box in the layout, so fan-out is visible rather than implied by a count.",
    example: "BillingService consumes OrderCreated from orders",
  },
  {
    name: "Verb-first edges",
    syntax:
      "publish <event> from <service> [to <channel>]\nconsume <event> by <service> [from <channel>]",
    summary:
      "The same two edges written event-first. Both spellings parse to the same node, so a document can be written the way it reads best.",
    example:
      "publish OrderCreated from OrderService to orders\nconsume OrderCreated by BillingService from orders",
  },
  {
    name: "Comment",
    syntax: "# <text>",
    summary:
      "Everything from `#` to the end of the line is ignored. Comments are recognised only at the start of a line, so a `#` inside a metadata value is kept.",
    example: "# events first, then the channels that carry them",
  },
];
