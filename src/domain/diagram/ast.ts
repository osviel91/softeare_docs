/**
 * Abstract Syntax Tree for the Sequence Diagram DSL.
 *
 * These types are deliberately source-annotated: every node carries a
 * {@link SourceRange} so diagnostics can point back to the exact line, column,
 * and character range in the original document. The AST is framework-free — it
 * knows nothing about rendering, editing, or persistence.
 *
 * Node discrimination uses the `type` field. Messages carry their visual
 * semantics explicitly ({@link LineStyle} × {@link ArrowStyle}) rather than an
 * arrow string, so the parser's job is only to map DSL syntax onto this model
 * and the renderer never re-interprets source text (see ADR-004, ADR-013).
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

/**
 * Whether a lifeline is drawn as a rectangular participant box or as a human
 * actor figure. Both behave identically in the sequence (they own a lifeline
 * and exchange messages); only the glyph differs (see ADR-013).
 */
export type ParticipantType = "participant" | "actor";

/** A participant declaration, e.g. `participant User` or `actor User`. */
export interface ParticipantNode {
  type: "participant";
  /** Which glyph represents this lifeline. */
  participantType: ParticipantType;
  /** The identifier used by messages to reference this participant. */
  id: ParticipantId;
  /** The display label (defaults to `id` when omitted). */
  label: string;
  /** Source span covering the whole declaration. */
  range: SourceRange;
}

/** The line style of a message arrow. */
export type LineStyle = "solid" | "dashed";

/**
 * The ending drawn at a message's head. `none` is a bare line; `arrow` is a
 * filled triangular head; `open` is an open (async) head; `cross` marks a
 * failed/dropped delivery; `bidirectional` puts a head at both ends.
 */
export type ArrowStyle = "none" | "arrow" | "open" | "cross" | "bidirectional";

/** The architectural message kinds shared with Event Flow. */
export type SequenceMessageKind = "event" | "command";

/** The local role of an architectural message occurrence in a Sequence. */
export type SequenceMessageOperation = "publish" | "consume" | "dispatch";

/** Structured architectural meaning attached to one Sequence interaction. */
export interface SequenceMessageSemantics {
  name: string;
  kind: SequenceMessageKind;
  operation: SequenceMessageOperation;
  /** Reserved for D03.11.2; local names are never cross-resource identity. */
  messageRef?: string;
  range: SourceRange;
}

/** A message between two participants, e.g. `User ->> API: Login`. */
export interface MessageNode {
  type: "message";
  /** Solid or dashed stroke. */
  lineStyle: LineStyle;
  /** Ending drawn at the head (and, for bidirectional, the tail). */
  arrowStyle: ArrowStyle;
  /** The participant the message originates from. */
  from: ParticipantId;
  /** The participant the message is addressed to. */
  to: ParticipantId;
  /** The label shown with the arrow (may be empty). */
  label: string;
  /** Optional evidence-backed architectural message occurrence. */
  semantics?: SequenceMessageSemantics;
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
 * A `loop` fragment, e.g. `loop retry up to 3 times ... end`.
 *
 * Fragments are statements that own nested statements rather than being
 * flattened into messages, so the layout engine can draw a frame around the
 * region and the renderer can label it (see ADR-014).
 */
export interface LoopNode {
  type: "loop";
  /** The loop's description, shown in the frame's tab. May be empty. */
  label: string;
  /** Statements executed inside the loop. */
  statements: Statement[];
  /** Source span covering the whole fragment, from `loop` through `end`. */
  range: SourceRange;
}

/** One `else` branch of an {@link AltNode}. */
export interface AltBranch {
  /** The branch's guard text. Empty for the leading `alt` branch when omitted. */
  condition: string;
  statements: Statement[];
  range: SourceRange;
}

/** An `alt`/`else` alternative fragment. */
export interface AltNode {
  type: "alt";
  /** The leading branch plus one per `else`. Always at least one. */
  branches: AltBranch[];
  range: SourceRange;
}

/** An `opt` (optional) fragment: a single guarded block. */
export interface OptNode {
  type: "opt";
  label: string;
  statements: Statement[];
  range: SourceRange;
}

/** One `and` branch of a {@link ParNode}. */
export interface ParBranch {
  label: string;
  statements: Statement[];
  range: SourceRange;
}

/** A `par`/`and` parallel fragment. */
export interface ParNode {
  type: "par";
  branches: ParBranch[];
  range: SourceRange;
}

/** One `option` branch of a {@link CriticalNode}. */
export interface CriticalBranch {
  label: string;
  statements: Statement[];
  range: SourceRange;
}

/** A `critical`/`option` fragment: a critical region with alternative handling. */
export interface CriticalNode {
  type: "critical";
  branches: CriticalBranch[];
  range: SourceRange;
}

/** A `break` fragment: an interruption flow out of the enclosing fragment. */
export interface BreakNode {
  type: "break";
  label: string;
  statements: Statement[];
  range: SourceRange;
}

/** Any statement that can appear in a diagram or inside a fragment. */
export type Statement =
  | MessageNode
  | ActivationNode
  | LoopNode
  | AltNode
  | OptNode
  | ParNode
  | CriticalNode
  | BreakNode;

/**
 * Where a note is anchored.
 *
 * - `left` / `right`: the note sits to the left / right of the referenced
 *   participant's lifeline (one participant).
 * - `over`: the note is centered over one participant, spans several
 *   (`note over A,B`), or, with no participant, spans the whole diagram.
 * - `on`: the note is attached to a message, named by its step number
 *   (`note on 3 : text`) — the number the diagram prints in a circle.
 */
export type NotePlacement = "left" | "right" | "over" | "on";

/**
 * A note, e.g. `note left of User : Confidential`.
 *
 * A note is a callout attached to participants, to a single message, or to the
 * diagram as a whole. It is not a message: it carries no arrow and never
 * participates in semantic endpoint validation. `text` may contain newlines for
 * a multiline note.
 */
export interface NoteNode {
  type: "note";
  /** How the note is anchored to its target. */
  placement: NotePlacement;
  /**
   * Referenced participants, in source order: exactly one for `left` / `right`,
   * one or more for `over` (empty means a diagram-wide `over` note), and empty
   * for `on` (which targets a message instead).
   */
  participants: ParticipantId[];
  /**
   * For `placement: "on"`, the 1-based step number of the message the note is
   * attached to — the same number the renderer prints in the circled badge.
   */
  messageNumber?: number;
  /** The note's text body (may contain `\n`; never empty). */
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

/** Walk every statement in a list, including those nested in fragments. */
export function* walkStatements(statements: Statement[]): Generator<Statement> {
  for (const statement of statements) {
    yield statement;
    switch (statement.type) {
      case "loop":
      case "opt":
      case "break":
        yield* walkStatements(statement.statements);
        break;
      case "alt":
        for (const branch of statement.branches) {
          yield* walkStatements(branch.statements);
        }
        break;
      case "par":
        for (const branch of statement.branches) {
          yield* walkStatements(branch.statements);
        }
        break;
      case "critical":
        for (const branch of statement.branches) {
          yield* walkStatements(branch.statements);
        }
        break;
      default:
        // A leaf statement (message or activation) has nothing to descend into.
        break;
    }
  }
}
