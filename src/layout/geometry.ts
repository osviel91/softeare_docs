/**
 * Layout geometry: the constants and types shared by the layout engine and the
 * SVG renderer. Keeping these in one place means both layers agree on sizes,
 * spacing, and coordinate conventions without duplicating magic numbers.
 */

/** Horizontal margin around the widest participant label / message label. */
export const MARGIN_X = 24;

/** Vertical space reserved at the top for the diagram title, or 0 if none. */
export const TITLE_HEIGHT = 28;

/** Vertical space for the participant name box at the top of each lifeline. */
export const PARTICIPANT_BOX_HEIGHT = 24;

/** Vertical distance between consecutive message rows. */
export const MESSAGE_ROW_HEIGHT = 44;

/** Horizontal distance between the centers of consecutive participants. */
export const PARTICIPANT_SPACING = 120;

/** Minimum width of a participant's label box. */
export const MIN_PARTICIPANT_WIDTH = 72;

/** Width of the arrowhead triangle, in pixels. */
export const ARROW_HEAD_SIZE = 8;

/** Height of the arrowhead triangle, in pixels. */
export const ARROW_HEAD_HEIGHT = 12;

/** Stroke width used for lifelines and message arrows. */
export const STROKE_WIDTH = 1.5;

/**
 * Geometry of a single participant's lifeline after layout.
 *
 * `x` is the vertical center line of the lifeline (and its box). `topY`/`bottomY`
 * bound the drawn lifeline vertically (below the title/participant box, past all
 * messages). `width` is the participant name box width.
 */
export interface ParticipantLayout {
  id: string;
  label: string;
  /** Center x of the lifeline (and of the participant box). */
  x: number;
  /** Top edge of the participant box / start of the lifeline. */
  topY: number;
  /** Bottom edge of the drawn lifeline (past all messages). */
  bottomY: number;
  /** Width of the participant name box, so the renderer matches the layout. */
  width: number;
}

/** Geometry of a single message arrow after layout. */
export interface MessageLayout {
  from: string;
  to: string;
  kind: "sync" | "response";
  label: string;
  /** Vertical center line of this message row. */
  y: number;
  /** X coordinate of the arrow tail (on the sender's lifeline). */
  startX: number;
  /** X coordinate of the arrow head base (on the receiver's lifeline). */
  endX: number;
}

/** The full geometric description of a diagram, ready to be rendered. */
export interface DiagramLayout {
  width: number;
  height: number;
  /** The diagram title text, or undefined when the diagram has none. */
  title?: string;
  participants: ParticipantLayout[];
  messages: MessageLayout[];
}
