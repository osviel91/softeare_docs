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
    summary: "An optional heading for the diagram.",
    example: "title Authentication Flow",
  },
  {
    name: "Participant",
    syntax: "participant <name>",
    summary:
      "Declares a lifeline. Participants must be declared before any message.",
    example: "participant User\nparticipant API",
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
    syntax: "<from> -> <to> [: label]",
    summary:
      "A solid arrow from one lifeline to another. The label is optional.",
    example: "User -> API: Login",
  },
  {
    name: "Response",
    syntax: "<from> --> <to> [: label]",
    summary: "A dashed, headless arrow, drawn as a return message.",
    example: "API --> User: Token",
  },
  {
    name: "Note",
    syntax: "note left|right of <participant> : <text>",
    summary:
      "A callout beside a lifeline. Use `note over : <text>` to span the whole diagram.",
    example: "note right of API : Reads from cache",
  },
  {
    name: "Activation",
    syntax: "activate <participant> / deactivate <participant>",
    summary:
      "Draws a bar over a lifeline for the span in which that participant is working. Bars nest, and one left open runs to the end of the diagram.",
    example: "activate API\nAPI -> API: Work\ndeactivate API",
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
