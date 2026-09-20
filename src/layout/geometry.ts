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

/** Width of an activation bar drawn over a lifeline. */
export const ACTIVATION_WIDTH = 10;

/** Horizontal shift applied per nesting level so stacked bars stay visible. */
export const ACTIVATION_NEST_OFFSET = 4;

/** Minimum height of an activation bar, so a zero-length span is still drawn. */
export const ACTIVATION_MIN_HEIGHT = 12;

/** Height of a note box, in pixels. */
export const NOTE_HEIGHT = 32;

/** Vertical space reserved per note within the dedicated notes band. */
export const NOTE_ROW_HEIGHT = 48;

/** Vertical margin above and below the notes band. */
export const NOTE_MARGIN_Y = 12;

/** Horizontal gap between a note box and the lifeline it is anchored to. */
export const NOTE_GAP = 8;

/** Minimum width of a note box. */
export const NOTE_MIN_WIDTH = 64;

/** Half-width of the span a diagram-wide `over` note covers. */
export const NOTE_OVER_SPAN_HALF = 96;

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

/** Geometry of a single note box after layout.
 *
 * `x`/`y` is the top-left corner of the box; `width`/`height` bound it. The
 * box is positioned relative to the lifeline it is anchored to (see the layout
 * engine). For a diagram-wide `over` note, `participant` is `undefined`.
 */
export interface NoteLayout {
  /** How the note is anchored to a lifeline (or the whole diagram). */
  placement: "left" | "right" | "over";
  /** Referenced participant id, or `undefined` for a diagram-wide note. */
  participant?: string;
  /** The note text, retained for reference and debugging. */
  text: string;
  /** Top edge of the note box. */
  y: number;
  /** Left edge of the note box. */
  x: number;
  /** Width of the note box. */
  width: number;
  /** Height of the note box (always {@link NOTE_HEIGHT}). */
  height: number;
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
}

/** The full geometric description of a diagram, ready to be rendered. */
export interface DiagramLayout {
  width: number;
  height: number;
  /** The diagram title text, or undefined when the diagram has none. */
  title?: string;
  participants: ParticipantLayout[];
  messages: MessageLayout[];
  activations: ActivationLayout[];
  notes: NoteLayout[];
}
