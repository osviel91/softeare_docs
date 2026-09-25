/**
 * Sequence layout engine.
 *
 * Pure and deterministic: given a {@link SequenceDiagram} AST it produces a
 * {@link DiagramLayout} describing every participant's lifeline, every message
 * arrow's geometry, and the frames of any control-flow fragments. It knows
 * nothing about SVG or the DOM — it only computes coordinates. The renderer
 * consumes this layout.
 *
 * Layout rules (per the product spec):
 * - Participants are placed left-to-right with consistent spacing.
 * - Lifelines are vertical, aligned on each participant's center x.
 * - Messages are stacked top-to-bottom in source order.
 * - Arrow tails/heads sit exactly on the sender/receiver lifelines.
 * - A fragment owns a frame around the rows it contains, with a header band and
 *   (`else` / `and` / `option`) separator lines; fragments nest.
 * - The diagram widens to fit the widest label and lengthens for long labels.
 */
import type {
  MessageNode,
  NoteNode,
  ParticipantId,
  SequenceDiagram,
  SourceRange,
  Statement,
} from "../domain/diagram/ast";
import { nodeIdOf } from "../domain/diagram/node-id";
import { wrapText } from "./text";
import {
  ACTIVATION_MIN_HEIGHT,
  ACTIVATION_NEST_OFFSET,
  ACTOR_HEIGHT,
  FRAGMENT_BOTTOM_PADDING,
  FRAGMENT_DIVIDER_HEIGHT,
  FRAGMENT_HEADER_HEIGHT,
  FRAGMENT_INSET,
  FRAGMENT_MIN_WIDTH,
  FRAGMENT_PADDING_X,
  MARGIN_X,
  MIN_PARTICIPANT_WIDTH,
  MESSAGE_ROW_HEIGHT,
  MESSAGE_TOP_CLEARANCE,
  NOTE_BULLET_OFFSET,
  NOTE_BULLET_SPACING,
  NOTE_BULLET_TOP_OFFSET,
  NOTE_GAP,
  NOTE_HEIGHT,
  NOTE_LINE_HEIGHT,
  NOTE_MIN_WIDTH,
  PARTICIPANT_BOX_HEIGHT,
  PARTICIPANT_SPACING,
  SELF_MESSAGE_HEIGHT,
  SELF_MESSAGE_LABEL_GAP,
  SELF_MESSAGE_WIDTH,
  TITLE_HEIGHT,
  type ActivationLayout,
  type DiagramLayout,
  type FragmentDividerLayout,
  type FragmentLayout,
  type MessageLayout,
  type NoteLayout,
  type ParticipantLayout,
} from "./geometry";

/** A fragment statement (anything that owns nested statements). */
type FragmentStatement = Exclude<
  Statement,
  MessageNode | { type: "activation" }
>;

/** Estimate the pixel width of a label using an average character width. */
function estimateLabelWidth(label: string): number {
  if (label.length === 0) return MARGIN_X;
  // ~7px per character is a reasonable average for a monospace-ish estimate.
  return Math.max(MARGIN_X, label.length * 7 + 8);
}

/** Compute the participant box width for a label, bounded by a minimum. */
function participantBoxWidth(label: string): number {
  return Math.min(180, Math.max(MIN_PARTICIPANT_WIDTH, estimateLabelWidth(label) + 16));
}

/** The longest line of a (possibly multiline) note, in characters. */
function longestLine(text: string): number {
  return text
    .split("\n")
    .reduce((longest, line) => Math.max(longest, line.length), 0);
}

/** Estimate the pixel width of a note body, bounded by a minimum. */
function noteWidth(text: string): number {
  const longest = longestLine(text);
  if (longest === 0) return NOTE_MIN_WIDTH;
  return Math.min(240, Math.max(NOTE_MIN_WIDTH, longest * 7 + 16));
}

/** Height of a note box, growing one line at a time for multiline text. */
function noteHeight(text: string): number {
  const lines = wrapText(text, noteWidth(text) - 16, 12).length;
  return NOTE_HEIGHT + Math.max(0, lines - 1) * NOTE_LINE_HEIGHT;
}

/** Collect every participant id referenced anywhere inside `statements`. */
function referencedParticipants(statements: Statement[]): Set<ParticipantId> {
  const ids = new Set<ParticipantId>();
  const visit = (list: Statement[]): void => {
    for (const statement of list) {
      switch (statement.type) {
        case "message":
          ids.add(statement.from);
          ids.add(statement.to);
          break;
        case "activation":
          ids.add(statement.participant);
          break;
        case "loop":
        case "opt":
        case "break":
          visit(statement.statements);
          break;
        case "alt":
        case "par":
        case "critical":
          for (const branch of statement.branches) visit(branch.statements);
          break;
      }
    }
  };
  visit(statements);
  return ids;
}

/** The labelled branches of a fragment, normalized across fragment kinds. */
function fragmentBranches(
  statement: FragmentStatement,
): { label: string; statements: Statement[]; range: SourceRange }[] {
  switch (statement.type) {
    case "loop":
    case "opt":
    case "break":
      return [
        {
          label: statement.label,
          statements: statement.statements,
          range: statement.range,
        },
      ];
    case "alt":
      return statement.branches.map((branch) => ({
        label: branch.condition,
        statements: branch.statements,
        range: branch.range,
      }));
    case "par":
      return statement.branches.map((branch) => ({
        label: branch.label,
        statements: branch.statements,
        range: branch.range,
      }));
    case "critical":
      return statement.branches.map((branch) => ({
        label: branch.label,
        statements: branch.statements,
        range: branch.range,
      }));
  }
}

/**
 * Lay out a note's bullet and the callout box that appears when it is expanded.
 *
 * A note is attached to one or more participants (the bullet sits just below the
 * participant band; left / right / over depending on placement), to a single
 * message by its step number (`note on 3`, anchored below that arrow's midpoint),
 * or to the whole diagram (`note over :`). The callout box is positioned next to
 * the bullet so expanding a bullet never moves the element it belongs to and
 * never reflows the message rows.
 *
 * Notes that share an anchor stack their bullets vertically, so two notes on one
 * lifeline (or on one message) are both clickable instead of overlapping.
 */
function layoutNotes(
  notes: NoteNode[],
  participantsById: Map<string, ParticipantLayout>,
  messages: MessageLayout[],
  bandBottom: number,
  diagramWidth: number,
): NoteLayout[] {
  // How many notes are already attached to each anchor, so stacked bullets can
  // be offset down the lifeline. The diagram anchor is keyed by an empty string.
  const stacked = new Map<string, number>();

  return notes.map((note) => {
    const targets = note.participants
      .map((id) => participantsById.get(id))
      .filter((p): p is ParticipantLayout => p !== undefined);

    const anchorKey =
      note.placement === "on"
        ? `#${note.messageNumber ?? 0}`
        : note.participants.join(",");
    const stackIndex = stacked.get(anchorKey) ?? 0;
    stacked.set(anchorKey, stackIndex + 1);

    const textWidth = noteWidth(note.text);
    const labelLines = wrapText(note.text, textWidth - 16, 12);
    const height = noteHeight(note.text);
    let anchorX: number;
    let width: number;
    let anchorY: number;

    // A `note on <n>` targets the message the renderer numbers `n` (1-based).
    const target =
      note.placement === "on" && note.messageNumber !== undefined
        ? messages[note.messageNumber - 1]
        : undefined;

    if (target) {
      // Anchor below the arrow's midpoint — or, for a self-message, below the
      // middle of its loop — so the note does not cover the arrow it describes.
      anchorX = target.selfLoop
        ? target.startX + target.selfLoop.width / 2
        : (target.startX + target.endX) / 2;
      anchorY =
        target.y + NOTE_BULLET_TOP_OFFSET + stackIndex * NOTE_BULLET_SPACING;
      width = textWidth;
    } else {
      if (targets.length === 0) {
        // Diagram-wide `over`, an unresolved `on`, or a semantic error: anchor
        // at the top center.
        anchorX = diagramWidth / 2;
        width = textWidth;
      } else {
        const xs = targets.map((p) => p.x);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        if (note.placement === "left") {
          anchorX = minX - NOTE_BULLET_OFFSET;
          width = textWidth;
        } else if (note.placement === "right") {
          anchorX = maxX + NOTE_BULLET_OFFSET;
          width = textWidth;
        } else {
          // `over`: centered on the (possibly several) participants, and at
          // least wide enough to span them.
          anchorX = (minX + maxX) / 2;
          width = Math.max(textWidth, maxX - minX + 2 * NOTE_GAP);
        }
      }
      anchorY =
        bandBottom + NOTE_BULLET_TOP_OFFSET + stackIndex * NOTE_BULLET_SPACING;
    }

    const { x, y } = placeNoteBox(note, anchorX, anchorY, width, height);

    return {
      placement: note.placement,
      participants: note.participants,
      messageNumber: note.messageNumber,
      text: note.text,
      labelLines,
      anchorX,
      anchorY,
      x,
      y,
      width,
      height,
      nodeId: nodeIdOf("note", note.range),
    };
  });
}

/**
 * Compute the top-left corner of an expanded note's callout box.
 *
 * `left` / `right` boxes sit beside their bullet, vertically centered on it;
 * `over` and `on` boxes hang below it. A box is clamped to the left margin and
 * to the top of the canvas so it never starts outside the drawing, and `right` /
 * `over` / `on` boxes are allowed to extend past the right edge — the caller
 * widens the canvas to fit them.
 */
function placeNoteBox(
  note: NoteNode,
  anchorX: number,
  anchorY: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const y = Math.max(0, anchorY - height / 2);
  switch (note.placement) {
    case "left":
      return { x: Math.max(MARGIN_X, anchorX - NOTE_GAP - width), y };
    case "right":
      return { x: anchorX + NOTE_GAP, y };
    case "over":
    case "on":
      // An `over` / `on` note hangs below its bullet so it does not cover the
      // participant box or the message arrow it annotates.
      return {
        x: Math.max(MARGIN_X, anchorX - width / 2),
        y: Math.max(0, anchorY + NOTE_GAP),
      };
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
    fragments: [],
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

  // Vertical bands, top to bottom: the optional title, the participant band,
  // then the message rows. The band is taller when any lifeline is an actor, so
  // a human figure and a name box can share the same top edge.
  const hasActor = diagram.participants.some(
    (p) => p.participantType === "actor",
  );
  const participantLines = diagram.participants.map((p) =>
    wrapText(p.label, participantBoxWidth(p.label) - 16, 13),
  );
  const labelBandHeight = Math.max(
    PARTICIPANT_BOX_HEIGHT,
    ...participantLines.map((lines) => lines.length * 15 + 9),
  );
  const bandHeight = hasActor ? Math.max(ACTOR_HEIGHT, labelBandHeight) : labelBandHeight;
  const titleHeight = diagram.title ? TITLE_HEIGHT : 0;
  /** Top edge of the participant band. */
  const bandTop = titleHeight + bandHeight;
  /** Y where every dashed lifeline starts. */
  const lifelineTop = bandTop + bandHeight;
  /** Vertical centering offset for name boxes when an actor forces a tall band. */
  const boxOffset = hasActor ? (bandHeight - labelBandHeight) / 2 : 0;

  const n = diagram.participants.length;
  const headerGap = PARTICIPANT_SPACING - MIN_PARTICIPANT_WIDTH;
  const participants: ParticipantLayout[] = [];
  for (const [index, p] of diagram.participants.entries()) {
    const width = participantBoxWidth(p.label);
    const previous = participants.at(-1);
    const x = previous
      ? previous.x + Math.max(PARTICIPANT_SPACING, previous.width / 2 + headerGap + width / 2)
      : MARGIN_X + Math.max(PARTICIPANT_SPACING / 2, width / 2);
    participants.push({
      id: p.id,
      label: p.label,
      participantType: p.participantType,
      x,
      topY: bandTop + (p.participantType === "actor" ? 0 : boxOffset),
      lifelineTop,
      width,
      labelLines: participantLines[index],
      boxHeight: labelBandHeight,
      bottomY: 0, // filled in after the body is placed
      nodeId: nodeIdOf("participant", p.range),
    });
  }

  /** Y center of the next message row. Fragments advance it by extra bands. */
  let cursorY = lifelineTop + MESSAGE_TOP_CLEARANCE;

  const messages: MessageLayout[] = [];
  const activations: ActivationLayout[] = [];
  const fragments: FragmentLayout[] = [];
  // Open bars per participant, innermost last.
  const openBars = new Map<ParticipantId, OpenBar[]>();

  const participantsById = new Map(participants.map((p) => [p.id, p]));
  const baseWidth = Math.max(
    MARGIN_X + n * PARTICIPANT_SPACING,
    participants.at(-1)!.x + participants.at(-1)!.width / 2 + MARGIN_X,
  );

  /** Place one message arrow at `y`. */
  const layoutMessage = (statement: MessageNode, y: number): void => {
    const fromIndex = byId.get(statement.from);
    const toIndex = byId.get(statement.to);
    // Endpoints that resolve to the same lifeline are a self-message (either
    // literally `A -> A`, or two spellings of one participant via an alias).
    // `fromIndex === toIndex` can only be true when both resolved, so an
    // unknown-participant message (a semantic error) is not mistaken for one.
    const isSelf = fromIndex !== undefined && fromIndex === toIndex;
    messages.push({
      from: statement.from,
      to: statement.to,
      lineStyle: statement.lineStyle,
      arrowStyle: statement.arrowStyle,
      label: statement.label,
      labelLines: wrapText(
        statement.label,
        Math.max(80, Math.abs((participants[fromIndex ?? 0]?.x ?? MARGIN_X) - (participants[toIndex ?? 0]?.x ?? MARGIN_X)) - 28),
        12,
      ),
      y,
      // Missing endpoints are a semantic error handled by the validator;
      // layout defensively falls back to the margin and still records the
      // message rather than dropping it.
      startX: fromIndex !== undefined ? participants[fromIndex].x : MARGIN_X,
      endX: toIndex !== undefined ? participants[toIndex].x : MARGIN_X,
      // A self-message would otherwise be a zero-length horizontal arrow; the
      // loop geometry tells the renderer to draw the cycle instead.
      selfLoop: isSelf
        ? { width: SELF_MESSAGE_WIDTH, height: SELF_MESSAGE_HEIGHT }
        : undefined,
      nodeId: nodeIdOf("message", statement.range),
    });
  };

  /**
   * Horizontal extent of a fragment frame: it spans the boxes of the
   * participants it mentions, inset per nesting level. A fragment that mentions
   * no participant (or only unknown ones) spans the whole canvas width.
   */
  const fragmentExtent = (
    references: Set<ParticipantId>,
    depth: number,
  ): { left: number; right: number } => {
    const targets = [...references]
      .map((id) => participantsById.get(id))
      .filter((p): p is ParticipantLayout => p !== undefined);
    let left = MARGIN_X;
    let right = baseWidth - MARGIN_X;
    if (targets.length > 0) {
      left =
        Math.min(...targets.map((p) => p.x - p.width / 2)) - FRAGMENT_PADDING_X;
      right =
        Math.max(...targets.map((p) => p.x + p.width / 2)) + FRAGMENT_PADDING_X;
    }
    const inset = depth * FRAGMENT_INSET;
    left += inset;
    right -= inset;
    if (right - left < FRAGMENT_MIN_WIDTH) {
      const mid = (left + right) / 2;
      left = mid - FRAGMENT_MIN_WIDTH / 2;
      right = mid + FRAGMENT_MIN_WIDTH / 2;
    }
    return { left: Math.max(0, left), right };
  };

  /** Lay out a fragment frame around its branches. */
  const layoutFragment = (
    statement: FragmentStatement,
    depth: number,
  ): void => {
    const { left, right } = fragmentExtent(
      referencedParticipants([statement]),
      depth,
    );
    // The header sits in the space above the next row, but never above the
    // participant band.
    const boxTop = Math.max(lifelineTop + 2, cursorY - MESSAGE_ROW_HEIGHT / 2);
    cursorY = boxTop + FRAGMENT_HEADER_HEIGHT + MESSAGE_ROW_HEIGHT / 2;

    const branches = fragmentBranches(statement);
    const dividers: FragmentDividerLayout[] = [];
    branches.forEach((branch, index) => {
      if (index > 0) {
        dividers.push({
          y: cursorY - MESSAGE_ROW_HEIGHT / 2,
          label: branch.label,
          nodeId: nodeIdOf("branch", branch.range),
        });
        cursorY += FRAGMENT_DIVIDER_HEIGHT;
      }
      layoutBlock(branch.statements, depth + 1);
    });

    const contentBottom = cursorY - MESSAGE_ROW_HEIGHT / 2;
    const boxBottom = Math.max(
      boxTop + FRAGMENT_HEADER_HEIGHT + FRAGMENT_BOTTOM_PADDING,
      contentBottom + FRAGMENT_BOTTOM_PADDING,
    );
    fragments.push({
      kind: statement.type,
      label: branches[0]?.label ?? "",
      x: left,
      y: boxTop,
      width: right - left,
      height: boxBottom - boxTop,
      depth,
      dividers,
      nodeId: nodeIdOf(statement.type, statement.range),
    });
    // Resume the ordinary row rhythm below the frame.
    cursorY = boxBottom + MESSAGE_ROW_HEIGHT / 2;
  };

  /** Lay out a list of statements in order. */
  const layoutBlock = (statements: Statement[], depth: number): void => {
    for (const statement of statements) {
      if (statement.type === "message") {
        layoutMessage(statement, cursorY);
        cursorY += MESSAGE_ROW_HEIGHT;
        continue;
      }
      if (statement.type === "activation") {
        // Unknown participant (validator error): skip so layout stays total.
        const index = byId.get(statement.participant);
        if (index === undefined) continue;
        const participant = participants[index];
        const stack = openBars.get(participant.id) ?? [];
        openBars.set(participant.id, stack);
        if (statement.action === "activate") {
          stack.push({
            y: cursorY,
            depth: stack.length,
            participant,
            range: statement.range,
          });
        } else {
          // An unmatched `deactivate` is reported by the validator; ignore it.
          const open = stack.pop();
          if (open) activations.push(barLayout(open, cursorY));
        }
        continue;
      }
      layoutFragment(statement, depth);
    }
  };

  layoutBlock(diagram.statements, 0);

  const bottomY = cursorY;
  participants.forEach((p) => {
    p.bottomY = bottomY;
  });

  // A bar left open runs to the bottom of the message body.
  for (const stack of openBars.values()) {
    for (const open of stack) {
      activations.push(barLayout(open, bottomY));
    }
  }

  // Notes are attached to their element as bullets. Their expandable callout
  // boxes are overlays that never reflow the message rows, which keeps pan/zoom
  // stable when a bullet is expanded or collapsed.
  const notes = layoutNotes(
    diagram.notes,
    participantsById,
    messages,
    lifelineTop,
    baseWidth,
  );

  // A self-message loop and its label extend to the right of the lifeline, a
  // right-facing note callout past the rightmost participant, and a fragment
  // frame past the widest participant box, so widen the canvas to fit whichever
  // reaches furthest. The width is independent of which notes are expanded, so
  // toggling a bullet never re-fits the viewport.
  const selfLoopRight = messages.reduce((max, message) => {
    if (!message.selfLoop) return max;
    const labelWidth = message.label
      ? SELF_MESSAGE_LABEL_GAP + estimateLabelWidth(message.label)
      : 0;
    return Math.max(max, message.startX + message.selfLoop.width + labelWidth);
  }, baseWidth);
  const fragmentRight = fragments.reduce(
    (max, fragment) => Math.max(max, fragment.x + fragment.width),
    selfLoopRight,
  );
  const rightEdge = notes.reduce(
    (max, note) => Math.max(max, note.x + note.width),
    fragmentRight,
  );

  // A note attached to a message hangs below its arrow, so on the last rows its
  // box would fall outside the message body. Reserve room for the deepest such
  // box so it is never clipped; the reserved space is computed from the text,
  // not from which bullets are expanded, so toggling still never re-fits.
  const messageNoteBottom = notes.reduce(
    (max, note) =>
      note.placement === "on" ? Math.max(max, note.y + note.height) : max,
    0,
  );
  const height =
    messageNoteBottom > 0
      ? Math.max(bottomY, messageNoteBottom + FRAGMENT_BOTTOM_PADDING)
      : bottomY;

  return {
    width: Math.max(baseWidth, rightEdge),
    height,
    title: diagram.title ? diagram.title.value : undefined,
    participants,
    messages,
    activations,
    fragments,
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
  /** Source range of the `activate` statement that opened the bar. */
  range: SourceRange;
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
    nodeId: nodeIdOf("activation", open.range),
  };
}
