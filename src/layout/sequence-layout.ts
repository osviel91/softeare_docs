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
import type { ParticipantId, SequenceDiagram } from "../domain/diagram/ast";
import {
  MARGIN_X,
  MIN_PARTICIPANT_WIDTH,
  PARTICIPANT_BOX_HEIGHT,
  PARTICIPANT_SPACING,
  TITLE_HEIGHT,
  MESSAGE_ROW_HEIGHT,
  type DiagramLayout,
  type MessageLayout,
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

/** Build the layout for an empty diagram (no participants). */
function emptyLayout(): DiagramLayout {
  return {
    width: MARGIN_X * 2,
    height: PARTICIPANT_BOX_HEIGHT + TITLE_HEIGHT,
    participants: [],
    messages: [],
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

  return {
    width,
    height: bottomY,
    title: diagram.title ? diagram.title.value : undefined,
    participants,
    messages,
  };
}
