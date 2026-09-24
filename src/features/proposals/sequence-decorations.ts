import type { SemanticChange } from "../../domain/diff/resource-diff";
import { reviewTargetId } from "./review-targets";

/** Which dimensions of an interaction a modification actually changed. */
export interface SequenceInteractionDimensions {
  messageChanged: boolean;
  sourceChanged: boolean;
  targetChanged: boolean;
  directionChanged: boolean;
  interactionKindChanged: boolean;
}

/**
 * A review-only decoration for one sequence change, in the vocabulary of the
 * diagram rather than of source lines. `number` values are the 1-based rendered
 * ordinals on each side; zero means the element is absent on that side.
 */
export type SequenceDiffDecoration =
  | {
      kind: "added-participant" | "removed-participant" | "modified-participant";
      targetId: string;
      participantId: string;
    }
  | {
      kind: "added-interaction" | "removed-interaction";
      targetId: string;
      number: number;
    }
  | {
      kind: "modified-interaction";
      targetId: string;
      baseNumber: number;
      proposedNumber: number;
      dimensions: SequenceInteractionDimensions;
    };

interface InteractionShape {
  from: string;
  to: string;
  label: string;
  arrowStyle: string;
  lineStyle: string;
}

function shape(value: unknown): InteractionShape | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.from !== "string" ||
    typeof record.to !== "string" ||
    typeof record.label !== "string"
  )
    return null;
  return {
    from: record.from,
    to: record.to,
    label: record.label,
    arrowStyle: typeof record.arrowStyle === "string" ? record.arrowStyle : "",
    lineStyle: typeof record.lineStyle === "string" ? record.lineStyle : "",
  };
}

function ordinal(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : 0;
}

/**
 * Project semantic diff changes onto the sequence decorations the review layer
 * can actually draw. Event-flow and markdown changes produce no sequence
 * decoration, so they are ignored here.
 */
export function sequenceDiffDecorations(
  changes: SemanticChange[],
): SequenceDiffDecoration[] {
  const decorations: SequenceDiffDecoration[] = [];
  for (const change of changes) {
    if (change.entity === "participant") {
      if (
        change.kind === "added" ||
        change.kind === "removed" ||
        change.kind === "modified"
      )
        decorations.push({
          kind: `${change.kind}-participant`,
          targetId: reviewTargetId(change),
          participantId: change.identity,
        });
      continue;
    }
    if (change.entity !== "interaction") continue;
    const details = change.details ?? {};
    const oldShape = shape(details.old);
    const newShape = shape(details.new);
    const baseNumber = ordinal(details.baseNumber);
    const proposedNumber = ordinal(details.proposedNumber);
    if (change.kind === "modified" && oldShape && newShape) {
      const swapped =
        oldShape.from !== oldShape.to &&
        oldShape.from === newShape.to &&
        oldShape.to === newShape.from;
      decorations.push({
        kind: "modified-interaction",
        targetId: reviewTargetId(change),
        baseNumber,
        proposedNumber,
        dimensions: {
          messageChanged: oldShape.label !== newShape.label,
          sourceChanged: oldShape.from !== newShape.from,
          targetChanged: oldShape.to !== newShape.to,
          directionChanged: swapped,
          interactionKindChanged:
            oldShape.arrowStyle !== newShape.arrowStyle ||
            oldShape.lineStyle !== newShape.lineStyle,
        },
      });
    } else if (change.kind === "added" && proposedNumber > 0) {
      decorations.push({
        kind: "added-interaction",
        targetId: reviewTargetId(change),
        number: proposedNumber,
      });
    } else if (change.kind === "removed" && baseNumber > 0) {
      decorations.push({
        kind: "removed-interaction",
        targetId: reviewTargetId(change),
        number: baseNumber,
      });
    }
  }
  return decorations;
}
