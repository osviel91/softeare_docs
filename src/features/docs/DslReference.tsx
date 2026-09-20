/**
 * DSL reference ("Docs" view).
 *
 * A static, hand-written reference for exactly the constructs the language layer
 * supports today. It is deliberately plain data rendered to markup: the point is
 * that a user can check syntax without leaving the editor, and that the list
 * stays obviously in step with the parser rather than drifting behind it.
 *
 * Keeping it as data also means it can be asserted against the real grammar in
 * tests, so a construct cannot be documented without being implemented.
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

export default function DslReference() {
  return (
    <div className="docs" data-testid="dsl-reference">
      <p className="docs__intro">
        The editor owns a small sequence-diagram language. Every construct below
        is parsed, validated, and drawn by this project rather than delegated to
        a library.
      </p>
      <dl className="docs__list">
        {DSL_CONSTRUCTS.map((construct) => (
          <div className="docs__entry" key={construct.name}>
            <dt className="docs__name">{construct.name}</dt>
            <dd className="docs__body">
              <code className="docs__syntax" data-testid="docs-syntax">
                {construct.syntax}
              </code>
              <p className="docs__summary">{construct.summary}</p>
              <pre className="docs__example">
                <code>{construct.example}</code>
              </pre>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
