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

  // Every participant id that is directly declared, and every identifier a
  // message may legally name once aliases are resolved.
  const participantIds = new Map<ParticipantId, unknown>();
  const resolvableIds = new Map<ParticipantId, unknown>();

  // Detect duplicate participant declarations, pointing at each duplicate.
  for (const participant of diagram.participants) {
    const known = participantIds.has(participant.id);
    participantIds.set(participant.id, null);
    resolvableIds.set(participant.id, null);
    if (known) {
      diagnostics.push(
        errorDiagnostic(
          `Duplicate participant declaration "${participant.id}"`,
          DiagnosticCode.DuplicateParticipant,
          participant.range,
        ),
      );
    }
  }

  // Resolve aliases: each shorthand must name a declared participant. Valid
  // shorthands then become additional identifiers messages may use. Aliases may
  // not chain (an alias target is never another alias).
  for (const alias of diagram.aliases) {
    if (!participantIds.has(alias.target)) {
      diagnostics.push(
        errorDiagnostic(
          `Alias "${alias.alias}" references unknown participant "${alias.target}"`,
          DiagnosticCode.UnknownAliasTarget,
          alias.range,
        ),
      );
      continue;
    }
    resolvableIds.set(alias.alias, null);
  }

  // Every message endpoint must resolve to a declared participant or alias.
  for (const statement of diagram.statements) {
    for (const endpoint of [statement.from, statement.to]) {
      if (!resolvableIds.has(endpoint)) {
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
