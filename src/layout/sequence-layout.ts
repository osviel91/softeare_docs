/**
 * Sequence layout engine.
 *
 * Pure and deterministic: given a {@link SequenceDiagram} AST it produces a
 * {@link DiagramLayout} describing every participant's lifeline and every
 * message arrow's geometry. It knows nothing about SVG or the DOM — it only
 * computes coordinates. The renderer consumes this layout.
 *
 * Layout rules (per the product spec):
 * - Participants are placed left-to-right with consistent spacing.
 * - Lifelines are vertical, aligned on each participant's center x.
 * - Messages are stacked top-to-bottom in source order.
 * - Arrow tails/heads sit exactly on the sender/receiver lifelines.
 * - The diagram widens to fit the widest label and lengthens for long labels.
 */
import type {
  NoteNode,
  ParticipantId,
  SequenceDiagram,
} from "../domain/diagram/ast";
import {
  MARGIN_X,
  MIN_PARTICIPANT_WIDTH,
  PARTICIPANT_BOX_HEIGHT,
  PARTICIPANT_SPACING,
  TITLE_HEIGHT,
  MESSAGE_ROW_HEIGHT,
  NOTE_GAP,
  NOTE_HEIGHT,
  NOTE_MARGIN_Y,
  NOTE_MIN_WIDTH,
  NOTE_OVER_SPAN_HALF,
  NOTE_ROW_HEIGHT,
  type DiagramLayout,
  type MessageLayout,
  type NoteLayout,
  type ParticipantLayout,
} from "./geometry";

/** Estimate the pixel width of a label using an average character width. */
function estimateLabelWidth(label: string): number {
  if (label.length === 0) return MARGIN_X;
  // ~7px per character is a reasonable average for a monospace-ish estimate.
  return Math.max(MARGIN_X, label.length * 7 + 8);
}

/** Compute the participant box width for a label, bounded by a minimum. */
function participantBoxWidth(label: string): number {
  return Math.max(MIN_PARTICIPANT_WIDTH, estimateLabelWidth(label) + 16);
}

/** Estimate the pixel width of a note body, bounded by a minimum. */
function noteWidth(text: string): number {
  if (text.length === 0) return NOTE_MIN_WIDTH;
  return Math.max(NOTE_MIN_WIDTH, text.length * 7 + 16);
}

/**
 * Layout each note into its own box within a dedicated band placed below the
 * messages. Notes never disturb message geometry: they get their own rows, so
 * messages keep their source-order stacking and the diagram stays readable.
 *
 * Horizontal placement depends on the note's anchor:
 * - `left` / `right` of a participant sit just left / right of its lifeline.
 * - `over` a participant is centered on its lifeline.
 * - `over` with no participant spans the whole diagram, centered.
 */
function layoutNotes(
  notes: NoteNode[],
  participantsByX: Map<string, number>,
  messagesBottomY: number,
  diagramWidth: number,
): NoteLayout[] {
  const bandTopY = messagesBottomY + NOTE_MARGIN_Y;
  return notes.map((note, index) => {
    const width = noteWidth(note.text);
    const boxX = placeNoteX(note, participantsByX, diagramWidth, width);
    const y = bandTopY + index * NOTE_ROW_HEIGHT + NOTE_MARGIN_Y;
    return {
      placement: note.placement,
      participant: note.participant,
      text: note.text,
      y,
      x: boxX,
      width,
      height: NOTE_HEIGHT,
    };
  });
}

/** Compute the left edge of a note box from its placement and target. */
function placeNoteX(
  note: NoteNode,
  participantsByX: Map<string, number>,
  diagramWidth: number,
  width: number,
): number {
  if (note.placement === "over" && !note.participant) {
    // Diagram-wide note: center a box no wider than twice the target span.
    const span = Math.min(NOTE_OVER_SPAN_HALF * 2, diagramWidth - MARGIN_X * 2);
    return (diagramWidth - span) / 2;
  }

  const targetX = note.participant
    ? participantsByX.get(note.participant)
    : undefined;
  if (targetX === undefined) {
    // Anchored to a participant that was never laid out (semantic error):
    // fall back to the left margin.
    return MARGIN_X;
  }

  switch (note.placement) {
    case "left":
      return Math.max(MARGIN_X, targetX - width - NOTE_GAP);
    case "right":
      return targetX + NOTE_GAP;
    case "over":
      // Center on the lifeline, but keep the box inside the left margin.
      return Math.max(MARGIN_X, targetX - width / 2);
    default:
      return MARGIN_X;
  }
}

/** Build the layout for an empty diagram (no participants). */
function emptyLayout(): DiagramLayout {
  return {
    width: MARGIN_X * 2,
    height: PARTICIPANT_BOX_HEIGHT + TITLE_HEIGHT,
    participants: [],
    messages: [],
    notes: [],
  };
}

/**
 * Layout a sequence diagram AST into geometry.
 *
 * @throws if two participants share the same id (a duplicate that the validator
 * should have caught). This keeps layout total and predictable.
 */
export function layoutDiagram(diagram: SequenceDiagram): DiagramLayout {
  if (diagram.participants.length === 0) {
    return emptyLayout();
  }

  // Index participants for O(1) x lookups from messages.
  const byId = new Map<ParticipantId, number>();
  diagram.participants.forEach((p, index) => {
    if (byId.has(p.id)) {
      throw new Error(`Duplicate participant id "${p.id}" during layout`);
    }
    byId.set(p.id, index);
  });

  const n = diagram.participants.length;
  const participants: ParticipantLayout[] = diagram.participants.map(
    (p, index) => ({
      id: p.id,
      label: p.label,
      x: MARGIN_X + index * PARTICIPANT_SPACING + PARTICIPANT_SPACING / 2,
      topY: TITLE_HEIGHT + PARTICIPANT_BOX_HEIGHT,
      width: participantBoxWidth(p.label),
      bottomY: 0, // filled in after messages are placed
    }),
  );

  const titleHeight = diagram.title ? TITLE_HEIGHT : 0;
  const topY = titleHeight + PARTICIPANT_BOX_HEIGHT;

  // Place each message on its own row, in source order.
  const messages: MessageLayout[] = diagram.statements.map((s, index) => {
    const fromIndex = byId.get(s.from);
    const toIndex = byId.get(s.to);
    if (fromIndex === undefined || toIndex === undefined) {
      // Missing endpoints are a semantic error handled by the validator; layout
      // defensively skips drawing a broken arrow but still records it.
      const startX =
        fromIndex !== undefined ? participants[fromIndex].x : MARGIN_X;
      const endX = toIndex !== undefined ? participants[toIndex].x : MARGIN_X;
      return {
        from: s.from,
        to: s.to,
        kind: s.kind,
        label: s.label,
        y: topY + index * MESSAGE_ROW_HEIGHT,
        startX,
        endX,
      };
    }
    return {
      from: s.from,
      to: s.to,
      kind: s.kind,
      label: s.label,
      y: topY + index * MESSAGE_ROW_HEIGHT,
      startX: participants[fromIndex].x,
      endX: participants[toIndex].x,
    };
  });

  const bottomY = topY + messages.length * MESSAGE_ROW_HEIGHT;
  participants.forEach((p) => {
    p.bottomY = bottomY;
  });

  const width = MARGIN_X + n * PARTICIPANT_SPACING;

  // Layout notes below the messages, anchoring each to its target lifeline.
  const participantsByX = new Map<string, number>(
    participants.map((p) => [p.id, p.x]),
  );
  const notes = layoutNotes(diagram.notes, participantsByX, bottomY, width);

  // A right/over note may extend past the rightmost participant, so widen the
  // canvas to fit it; the notes band also lengthens the diagram.
  const rightEdge = notes.reduce(
    (max, note) => Math.max(max, note.x + note.width),
    width,
  );
  const notesBottomY =
    notes.length > 0
      ? bottomY + notes.length * NOTE_ROW_HEIGHT + NOTE_MARGIN_Y
      : bottomY;

  return {
    width: Math.max(width, rightEdge),
    height: notesBottomY,
    title: diagram.title ? diagram.title.value : undefined,
    participants,
    messages,
    notes,
  };
}
