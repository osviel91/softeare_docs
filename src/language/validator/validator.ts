/**
 * Semantic validation for a parsed {@link SequenceDiagram}.
 *
 * Validation is a pure function over the AST, independent of parsing and UI.
 * It checks contextual rules that cannot be enforced by the grammar alone:
 * every message must reference a participant that was actually declared, and no
 * participant may be declared twice.
 */
import type { ParticipantId, SequenceDiagram } from "../../domain/diagram/ast";
import {
  type Diagnostic,
  DiagnosticCode,
  errorDiagnostic,
} from "../diagnostics/diagnostics";

/** Validate a diagram's semantics, returning any diagnostics found. */
export function validateSemantics(diagram: SequenceDiagram): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Detect duplicate participant declarations, pointing at each duplicate.
  const declaredIds = new Map<ParticipantId, unknown>();
  for (const participant of diagram.participants) {
    if (declaredIds.has(participant.id)) {
      diagnostics.push(
        errorDiagnostic(
          `Duplicate participant declaration "${participant.id}"`,
          DiagnosticCode.DuplicateParticipant,
          participant.range,
        ),
      );
    } else {
      declaredIds.set(participant.id, null);
    }
  }

  // Every message endpoint must reference a declared participant.
  for (const statement of diagram.statements) {
    for (const endpoint of [statement.from, statement.to]) {
      if (!declaredIds.has(endpoint)) {
        diagnostics.push(
          errorDiagnostic(
            `Unknown participant "${endpoint}"`,
            DiagnosticCode.UnknownParticipant,
            statement.range,
          ),
        );
      }
    }
  }

  return diagnostics;
}

/** Whether a diagram has no semantic problems. */
export function isValid(diagram: SequenceDiagram): boolean {
  return validateSemantics(diagram).length === 0;
}
