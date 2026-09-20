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
  ACTIVATION_MIN_HEIGHT,
  ACTIVATION_NEST_OFFSET,
  MARGIN_X,
  MIN_PARTICIPANT_WIDTH,
  PARTICIPANT_BOX_HEIGHT,
  PARTICIPANT_SPACING,
  TITLE_HEIGHT,
  MESSAGE_ROW_HEIGHT,
  MESSAGE_TOP_CLEARANCE,
  NOTE_GAP,
  NOTE_HEIGHT,
  NOTE_MARGIN_Y,
  NOTE_MIN_WIDTH,
  NOTE_OVER_SPAN_HALF,
  NOTE_ROW_HEIGHT,
  type ActivationLayout,
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
    activations: [],
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

  // Aliases are resolved here too: the validator accepts a shorthand anywhere a
  // participant id is allowed, so layout must map the shorthand to the same
  // lifeline. Without this the lookup misses and the arrow is drawn detached at
  // the left margin. An alias whose target was never declared is a semantic
  // error reported by the validator; skip it here.
  for (const alias of diagram.aliases) {
    const targetIndex = byId.get(alias.target);
    if (targetIndex !== undefined) byId.set(alias.alias, targetIndex);
  }

  // Vertical bands, top to bottom: the optional title, the participant boxes,
  // then the message rows. Each band is derived from the one above it, and all
  // three share `boxTop`, so a diagram with no title cannot drift out of step
  // with one that has a title.
  const titleHeight = diagram.title ? TITLE_HEIGHT : 0;
  /** Top edge of every participant box (and so of the drawn lifelines). */
  const boxTop = titleHeight + PARTICIPANT_BOX_HEIGHT;
  /**
   * Vertical center of the first message row. It clears the boxes by a full box
   * height plus {@link MESSAGE_TOP_CLEARANCE} so the first row's label has room
   * above its arrow instead of landing on the name boxes.
   */
  const messagesTopY = boxTop + PARTICIPANT_BOX_HEIGHT + MESSAGE_TOP_CLEARANCE;

  const n = diagram.participants.length;
  const participants: ParticipantLayout[] = diagram.participants.map(
    (p, index) => ({
      id: p.id,
      label: p.label,
      x: MARGIN_X + index * PARTICIPANT_SPACING + PARTICIPANT_SPACING / 2,
      topY: boxTop,
      width: participantBoxWidth(p.label),
      bottomY: 0, // filled in after messages are placed
    }),
  );

  /** Vertical center line of a message row. */
  const rowY = (row: number): number => messagesTopY + row * MESSAGE_ROW_HEIGHT;

  // Walk the statements once. Messages take a row each; activation statements
  // take no row of their own, they only open or close a bar at the current
  // position, so an activation between two messages spans exactly that gap.
  const messages: MessageLayout[] = [];
  const activations: ActivationLayout[] = [];
  // Open bars per participant, innermost last.
  const openBars = new Map<ParticipantId, OpenBar[]>();

  for (const statement of diagram.statements) {
    if (statement.type === "message") {
      const fromIndex = byId.get(statement.from);
      const toIndex = byId.get(statement.to);
      messages.push({
        from: statement.from,
        to: statement.to,
        kind: statement.kind,
        label: statement.label,
        y: rowY(messages.length),
        // Missing endpoints are a semantic error handled by the validator;
        // layout defensively falls back to the margin and still records the
        // message rather than dropping it.
        startX: fromIndex !== undefined ? participants[fromIndex].x : MARGIN_X,
        endX: toIndex !== undefined ? participants[toIndex].x : MARGIN_X,
      });
      continue;
    }

    // Unknown participant (validator error): skip so layout stays total.
    const participantIndex = byId.get(statement.participant);
    if (participantIndex === undefined) continue;
    const participant = participants[participantIndex];

    const stack = openBars.get(participant.id) ?? [];
    openBars.set(participant.id, stack);

    if (statement.action === "activate") {
      stack.push({
        y: rowY(messages.length),
        depth: stack.length,
        participant,
      });
    } else {
      // An unmatched `deactivate` is reported by the validator; ignore it here.
      const open = stack.pop();
      if (open) {
        activations.push(barLayout(open, rowY(messages.length)));
      }
    }
  }

  const bottomY = rowY(messages.length);
  participants.forEach((p) => {
    p.bottomY = bottomY;
  });

  // A bar left open runs to the bottom of the message body.
  for (const stack of openBars.values()) {
    for (const open of stack) {
      activations.push(barLayout(open, bottomY));
    }
  }

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
    activations,
    notes,
  };
}

/** An activation bar that has been opened but not yet closed. */
interface OpenBar {
  /** Absolute y the bar starts at (the row the `activate` precedes). */
  y: number;
  /** Nesting depth, 0 for the outermost bar on that lifeline. */
  depth: number;
  /** The participant whose lifeline the bar sits on. */
  participant: ParticipantLayout;
}

/**
 * Build one activation bar from its open state and the y it closes at.
 *
 * The bar's vertical origin is the message-row y, so bars line up exactly with
 * the rows they span.
 */
function barLayout(open: OpenBar, bottomY: number): ActivationLayout {
  return {
    participant: open.participant.id,
    x: open.participant.x + open.depth * ACTIVATION_NEST_OFFSET,
    y: open.y,
    // A bar closed on its own row would be zero-height; keep it visible.
    height: Math.max(ACTIVATION_MIN_HEIGHT, bottomY - open.y),
    depth: open.depth,
  };
}
