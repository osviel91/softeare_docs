/**
 * Abstract Syntax Tree for the Sequence Diagram DSL.
 *
 * These types are deliberately source-annotated: every node carries a
 * {@link SourceRange} so diagnostics can point back to the exact line, column,
 * and character range in the original document. The AST is framework-free — it
 * knows nothing about rendering, editing, or persistence.
 *
 * Node discrimination uses the `type` field; a message additionally carries a
 * `kind` field for its arrow direction, per the product's AST shape.
 */

/** A stable identifier for a participant within a single diagram. */
export type ParticipantId = string;

/** A zero-based line number within the source document. */
export type Line = number;

/** A zero-based column number (character offset within a line) within source. */
export type Column = number;

/** A point in the source document, both zero-based. */
export interface SourcePosition {
  line: Line;
  column: Column;
}

/** An inclusive start / exclusive-ish end span over the source text. */
export interface SourceRange {
  /** Start position (inclusive). */
  start: SourcePosition;
  /** End position (exclusive of the final character). */
  end: SourcePosition;
}

/** A participant declaration, e.g. `participant User`. */
export interface ParticipantNode {
  type: "participant";
  /** The identifier used by messages to reference this participant. */
  id: ParticipantId;
  /** The display label (defaults to `id` when omitted). */
  label: string;
  /** Source span covering the whole declaration. */
  range: SourceRange;
}

/** The direction of a message arrow. */
export type MessageKind = "sync" | "response";

/** A message between two participants, e.g. `User -> API: Login`. */
export interface MessageNode {
  type: "message";
  /** Arrow style. `sync` is a solid line with a filled head; `response` is dashed. */
  kind: MessageKind;
  /** The participant the message originates from. */
  from: ParticipantId;
  /** The participant the message is addressed to. */
  to: ParticipantId;
  /** The label shown above the arrow (may be empty). */
  label: string;
  /** Source span covering the whole message. */
  range: SourceRange;
}

/**
 * An alias binding, e.g. `alias U = User`.
 *
 * It introduces a second identifier (`alias`) that messages may use to refer to
 * an already-declared participant (`target`). Aliases are resolved at
 * validation time; the renderer never sees them.
 */
export interface AliasNode {
  type: "alias";
  /** The shorthand identifier messages use to reference the participant. */
  alias: ParticipantId;
  /** The declared participant this shorthand resolves to. */
  target: ParticipantId;
  /** Source span covering the whole alias declaration. */
  range: SourceRange;
}

/** Any top-level statement in a diagram body. */
export type Statement = MessageNode | ActivationNode;

/** Whether an activation statement opens or closes a bar. */
export type ActivationAction = "activate" | "deactivate";

/**
 * An activation statement, e.g. `activate User` / `deactivate User`.
 *
 * An activation marks the span during which a participant is doing work: the
 * renderer draws a narrow bar over that participant's lifeline, from the
 * `activate` statement to the matching `deactivate`. Activations nest, so a
 * participant may hold several open bars at once (depth 0 is the outermost).
 *
 * Activation is a statement, not a message: it carries no arrow and no
 * endpoints, so it never takes part in message endpoint validation.
 */
export interface ActivationNode {
  type: "activation";
  /** Whether this statement opens or closes a bar. */
  action: ActivationAction;
  /** The participant whose lifeline is activated (may be an alias shorthand). */
  participant: ParticipantId;
  /** Source span covering the whole statement. */
  range: SourceRange;
}

/**
 * Where a note is anchored relative to a participant's lifeline.
 *
 * - `left` / `right`: the note sits to the left / right of the referenced
 *   participant's lifeline (requires a `participant`).
 * - `over`: the note is centered over the referenced participant, or, when no
 *   participant is given, over the whole diagram.
 */
export type NotePlacement = "left" | "right" | "over";

/**
 * A note, e.g. `note left of User : Confidential`.
 *
 * A note is a callout attached to a participant (or, for `over`, spanning the
 * diagram). It is not a message: it carries no arrow and never participates in
 * semantic endpoint validation. `participant` is `undefined` for a diagram-wide
 * `note over` (no target) note.
 */
export interface NoteNode {
  type: "note";
  /** How the note is anchored to its target lifeline. */
  placement: NotePlacement;
  /** The referenced participant, or `undefined` for a diagram-wide note. */
  participant?: ParticipantId;
  /** The note's text body (may be empty). */
  text: string;
  /** Source span covering the whole note declaration. */
  range: SourceRange;
}

/** A diagram title, e.g. `title Authentication Flow`. */
export interface TitleNode {
  value: string;
  range: SourceRange;
}

/** The root document: an optional title followed by statements. */
export interface SequenceDiagram {
  title?: TitleNode;
  participants: ParticipantNode[];
  /** Alias shorthands, resolved against declared participants at validation. */
  aliases: AliasNode[];
  statements: Statement[];
  /** Callout notes attached to participants or spanning the diagram. */
  notes: NoteNode[];
}
