/**
 * Layout geometry: the constants and types shared by the layout engine and the
 * SVG renderer. Keeping these in one place means both layers agree on sizes,
 * spacing, and coordinate conventions without duplicating magic numbers.
 */
import type {
  ArrowStyle,
  LineStyle,
  ParticipantType,
} from "../domain/diagram/ast";
import type { AstNodeId } from "../domain/diagram/node-id";

/** Horizontal margin around the widest participant label / message label. */
export const MARGIN_X = 24;

/** Vertical space reserved at the top for the diagram title, or 0 if none. */
export const TITLE_HEIGHT = 28;

/** Vertical space for the participant name box at the top of each lifeline. */
export const PARTICIPANT_BOX_HEIGHT = 24;

/**
 * Height of the participant band when the diagram contains an actor. An actor
 * is drawn as a human figure with its label beneath, which needs more room than
 * a plain name box; every lifeline in such a diagram starts below this band so
 * actor and participant glyphs stay top-aligned.
 */
export const ACTOR_HEIGHT = 48;

/** Height of the stick figure itself (the label sits below it). */
export const ACTOR_FIGURE_HEIGHT = 30;

/** Vertical distance between consecutive message rows. */
export const MESSAGE_ROW_HEIGHT = 44;

/**
 * Clearance between the participant band and the first message row. The first
 * row also has to fit its own label above the arrow, so it needs more room than
 * the box-to-box spacing alone.
 */
export const MESSAGE_TOP_CLEARANCE = 20;

/** Horizontal distance from a lifeline to the far edge of a self-message loop. */
export const SELF_MESSAGE_WIDTH = 44;

/**
 * Vertical drop of a self-message loop, from its top edge to its bottom edge.
 * Kept well under {@link MESSAGE_ROW_HEIGHT} so a loop never reaches into the
 * next row.
 */
export const SELF_MESSAGE_HEIGHT = 24;

/** Horizontal gap between a self-message loop and its label. */
export const SELF_MESSAGE_LABEL_GAP = 8;

/** Horizontal distance between the centers of consecutive participants. */
export const PARTICIPANT_SPACING = 120;

/** Minimum width of a participant's label box. */
export const MIN_PARTICIPANT_WIDTH = 72;

/** Width of the arrowhead triangle, in pixels. */
export const ARROW_HEAD_SIZE = 8;

/** Height of the arrowhead triangle, in pixels. */
export const ARROW_HEAD_HEIGHT = 12;

/** Radius of the circled step number drawn on every message. */
export const MESSAGE_BADGE_RADIUS = 8;

/**
 * Distance from a message's tail to the center of its step-number badge, so the
 * badge sits on the arrow just inside the sender's lifeline.
 */
export const MESSAGE_BADGE_INSET = 12;

/** Font size of the number inside a step-number badge. */
export const MESSAGE_BADGE_FONT_SIZE = 10;

/**
 * Vertical offset from a badge's center to its text baseline, approximating
 * vertical centering for {@link MESSAGE_BADGE_FONT_SIZE}.
 */
export const MESSAGE_BADGE_TEXT_OFFSET = 3.5;

/** Stroke width used for lifelines and message arrows. */
export const STROKE_WIDTH = 1.5;

/** Width of an activation bar drawn over a lifeline. */
export const ACTIVATION_WIDTH = 10;

/** Horizontal shift applied per nesting level so stacked bars stay visible. */
export const ACTIVATION_NEST_OFFSET = 4;

/** Minimum height of an activation bar, so a zero-length span is still drawn. */
export const ACTIVATION_MIN_HEIGHT = 12;

/** Height of a note box, in pixels. */
export const NOTE_HEIGHT = 32;

/** Height of one additional line in a multiline note. */
export const NOTE_LINE_HEIGHT = 15;

/** Horizontal gap between an expanded note box and the bullet it belongs to. */
export const NOTE_GAP = 8;

/** Minimum width of a note box. */
export const NOTE_MIN_WIDTH = 64;

/** Half-width of the span a diagram-wide `over` note covers. */
export const NOTE_OVER_SPAN_HALF = 96;

/** Radius of the bullet drawn on the element a note is attached to. */
export const NOTE_BULLET_RADIUS = 6;

/** Horizontal distance of a `left` / `right` bullet from its lifeline. */
export const NOTE_BULLET_OFFSET = 11;

/** Vertical distance of the first bullet below the participant name box. */
export const NOTE_BULLET_TOP_OFFSET = 12;

/** Vertical distance between bullets stacked on the same element. */
export const NOTE_BULLET_SPACING = 16;

/** Vertical space reserved for a fragment's header (its kind and label). */
export const FRAGMENT_HEADER_HEIGHT = 24;

/** Vertical space reserved for an `else` / `and` / `option` divider. */
export const FRAGMENT_DIVIDER_HEIGHT = 22;

/** Horizontal padding inside a fragment frame, beyond the actors it spans. */
export const FRAGMENT_PADDING_X = 14;

/** Extra bottom padding inside a fragment frame, below its last row. */
export const FRAGMENT_BOTTOM_PADDING = 8;

/** Horizontal inset applied per nesting level, so nested frames stay visible. */
export const FRAGMENT_INSET = 10;

/** Minimum width of a fragment frame. */
export const FRAGMENT_MIN_WIDTH = 96;

/**
 * Geometry of a single participant's lifeline after layout.
 *
 * `x` is the vertical center line of the lifeline (and its box). `topY` is the
 * top of the name box / actor glyph; `lifelineTop` is where the dashed lifeline
 * begins (below the whole participant band); `bottomY` bounds it past all
 * messages. `width` is the participant name box width.
 */
export interface ParticipantLayout {
  id: string;
  label: string;
  /** Whether the renderer draws a name box or an actor figure. */
  participantType: ParticipantType;
  /** Center x of the lifeline (and of the participant box). */
  x: number;
  /** Top edge of the participant box / actor figure. */
  topY: number;
  /** Y where the dashed lifeline starts (below the participant band). */
  lifelineTop: number;
  /** Bottom edge of the drawn lifeline (past all messages). */
  bottomY: number;
  /** Width of the participant name box, so the renderer matches the layout. */
  width: number;
  /** Wrapped label lines for long participant names. */
  labelLines?: string[];
  /** Height of the participant name box. */
  boxHeight?: number;
  /**
   * Deterministic id of this participant's AST node. The renderer emits it as
   * `data-node-id`, so a rendered element maps back to its source. Optional so
   * hand-built layouts (mostly in tests) remain valid.
   */
  nodeId?: AstNodeId;
}

/** Geometry of a single message arrow after layout. */
export interface MessageLayout {
  from: string;
  to: string;
  /** Solid or dashed stroke. */
  lineStyle: LineStyle;
  /** Ending drawn at the head (and, for bidirectional, the tail). */
  arrowStyle: ArrowStyle;
  label: string;
  /** Wrapped label lines for long message labels. */
  labelLines?: string[];
  /** Vertical center line of this message row. */
  y: number;
  /** X coordinate of the arrow tail (on the sender's lifeline). */
  startX: number;
  /** X coordinate of the arrow head base (on the receiver's lifeline). */
  endX: number;
  /**
   * Self-message geometry, present only when `from` and `to` resolve to the same
   * lifeline. Such a message has `startX === endX`, so instead of a zero-length
   * horizontal arrow the renderer draws a loop to the right of the lifeline;
   * these bound that loop. Absent for an ordinary message.
   */
  selfLoop?: {
    /** Distance from the lifeline to the loop's far edge. */
    width: number;
    /** Vertical drop from the loop's top edge to its bottom edge. */
    height: number;
  };
  /**
   * Deterministic id of this message's AST node. The renderer emits it as
   * `data-node-id`, so a rendered element maps back to its source. Optional so
   * hand-built layouts (mostly in tests) remain valid.
   */
  nodeId?: AstNodeId;
}

/**
 * Geometry of a single note after layout.
 *
 * A note has two pieces of geometry. The {@link NoteLayout.anchorX} /
 * {@link NoteLayout.anchorY} point is where its bullet is drawn, attached to the
 * element the note belongs to (a participant's lifeline, or the top of the
 * diagram for a diagram-wide note). The `x`/`y`/`width`/`height` box is the
 * callout shown when the bullet is expanded, positioned next to that bullet.
 *
 * For a spanning note (`note over A,B`) the box covers every named lifeline, and
 * the bullet sits at the midpoint; for a diagram-wide note there are no
 * participants and the bullet anchors near the top center of the canvas.
 */
export interface NoteLayout {
  /** How the note is anchored to a lifeline (or the whole diagram). */
  placement: "left" | "right" | "over" | "on";
  /** Referenced participant ids, in source order (may be empty). */
  participants: string[];
  /**
   * For `placement: "on"`, the 1-based step number of the message the note is
   * attached to; `undefined` for every other placement.
   */
  messageNumber?: number;
  /** The note text, retained for reference and debugging. May contain `\n`. */
  text: string;
  /** Wrapped lines used by the SVG callout. */
  labelLines?: string[];
  /** Horizontal center of the bullet that toggles this note. */
  anchorX: number;
  /** Vertical center of the bullet that toggles this note. */
  anchorY: number;
  /** Top edge of the expanded callout box. */
  y: number;
  /** Left edge of the expanded callout box. */
  x: number;
  /** Width of the expanded callout box. */
  width: number;
  /** Height of the expanded callout box (grows with multiline text). */
  height: number;
  /**
   * Deterministic id of the note's AST node. The renderer emits it as
   * `data-node-id`, so a rendered element maps back to its source. Optional so
   * hand-built layouts (mostly in tests) remain valid.
   */
  nodeId?: AstNodeId;
}

/** Geometry of a single activation bar after layout.
 *
 * `x` is the horizontal center of the bar (the lifeline it sits on, shifted by
 * {@link ACTIVATION_NEST_OFFSET} per nesting level); `y`/`height` bound it
 * vertically. A bar spans from its `activate` statement to the matching
 * `deactivate`, or to the bottom of the message body when left open.
 */
export interface ActivationLayout {
  /** Canonical id of the participant whose lifeline is activated. */
  participant: string;
  /** Horizontal center of the bar. */
  x: number;
  /** Top edge of the bar. */
  y: number;
  /** Height of the bar. */
  height: number;
  /** Zero-based nesting depth; 0 is the outermost bar for that participant. */
  depth: number;
  /**
   * Deterministic id of the activation's AST node. The renderer emits it as
   * `data-node-id`, so a rendered element maps back to its source. Optional so
   * hand-built layouts (mostly in tests) remain valid.
   */
  nodeId?: AstNodeId;
}

/** A branch separator line inside a fragment frame (`else`, `and`, `option`). */
export interface FragmentDividerLayout {
  /** Y of the separator line. */
  y: number;
  /** The branch's label, drawn just below the line. */
  label: string;
  /**
   * Deterministic id of the branch's AST node. The renderer emits it as
   * `data-node-id`, so a rendered element maps back to its source. Optional so
   * hand-built layouts (mostly in tests) remain valid.
   */
  nodeId?: AstNodeId;
}

/** Geometry of a control-flow frame (loop, alt, opt, par, critical, break). */
export interface FragmentLayout {
  kind: "loop" | "alt" | "opt" | "par" | "critical" | "break";
  /** The leading branch's description (shown next to the kind tag). */
  label: string;
  /** Left edge of the frame. */
  x: number;
  /** Top edge of the frame. */
  y: number;
  width: number;
  height: number;
  /** Zero-based nesting depth; 0 is the outermost frame. */
  depth: number;
  /** Separator lines for `else` / `and` / `option` branches, in order. */
  dividers: FragmentDividerLayout[];
  /**
   * Deterministic id of the fragment's AST node. The renderer emits it as
   * `data-node-id`, so a rendered element maps back to its source. Optional so
   * hand-built layouts (mostly in tests) remain valid.
   */
  nodeId?: AstNodeId;
}

/** The full geometric description of a diagram, ready to be rendered. */
export interface DiagramLayout {
  width: number;
  height: number;
  /** The diagram title text, or undefined when the diagram has none. */
  title?: string;
  participants: ParticipantLayout[];
  /**
   * Messages in source order. The renderer draws this order as the diagram's
   * step sequence, numbering each message from 1.
   */
  messages: MessageLayout[];
  activations: ActivationLayout[];
  /**
   * Control-flow frames, outermost first, in the order they were laid out. The
   * layout engine always provides this; it is optional so hand-built layouts
   * (mostly in tests) that predate fragments stay valid.
   */
  fragments?: FragmentLayout[];
  notes: NoteLayout[];
}
