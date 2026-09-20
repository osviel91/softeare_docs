/**
 * Semantic validation for a parsed {@link SequenceDiagram}.
 *
 * Validation is a pure function over the AST, independent of parsing and UI.
 * It checks contextual rules that cannot be enforced by the grammar alone:
 * every message must reference a participant that was actually declared, no
 * participant may be declared twice, activations must pair up, and fragment
 * nesting is traversed rather than flattened.
 */
import type { ParticipantId, SequenceDiagram } from "../../domain/diagram/ast";
import { walkStatements } from "../../domain/diagram/ast";
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
  // Shorthand -> declared participant, so checks that track one participant
  // across several statements can compare canonical ids.
  const aliasTargets = new Map<ParticipantId, ParticipantId>();

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
    aliasTargets.set(alias.alias, alias.target);
  }

  /** Canonical participant id for an identifier that may be an alias. */
  const resolve = (id: ParticipantId): ParticipantId =>
    aliasTargets.get(id) ?? id;

  // Walk every statement, including those nested inside fragments, in source
  // order. Messages and activations both reference participants by name.
  const statements = [...walkStatements(diagram.statements)];

  // Every message endpoint must resolve to a declared participant or alias.
  for (const statement of statements) {
    if (statement.type !== "message") continue;
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

  // Notes reference participants, or a message by its step number. A `note on
  // <n>` must point at a message the diagram actually has; the number is the
  // same 1-based step the renderer prints in the circled badge.
  const messageCount = statements.filter(
    (statement) => statement.type === "message",
  ).length;
  for (const note of diagram.notes) {
    for (const participant of note.participants) {
      if (!resolvableIds.has(participant)) {
        diagnostics.push(
          errorDiagnostic(
            `Unknown participant "${participant}"`,
            DiagnosticCode.UnknownParticipant,
            note.range,
          ),
        );
      }
    }
    if (note.placement !== "on") continue;
    const number = note.messageNumber;
    if (number === undefined || number < 1 || number > messageCount) {
      diagnostics.push(
        errorDiagnostic(
          `Note references message ${number ?? "?"}, but the diagram has ${messageCount} message${messageCount === 1 ? "" : "s"}`,
          DiagnosticCode.UnknownMessageNumber,
          note.range,
        ),
      );
    }
  }

  // Activations pair up like brackets, per participant: each `deactivate` must
  // close an open `activate`. Nesting is legal, so the number of open bars is
  // counted rather than tracked with a single flag. The walk is in source order,
  // so fragments do not break the pairing.
  const openActivations = new Map<ParticipantId, number>();
  for (const statement of statements) {
    if (statement.type !== "activation") continue;
    if (!resolvableIds.has(statement.participant)) {
      diagnostics.push(
        errorDiagnostic(
          `Unknown participant "${statement.participant}"`,
          DiagnosticCode.UnknownParticipant,
          statement.range,
        ),
      );
      continue;
    }

    // Compare canonical ids so `activate U` / `deactivate User` pair up.
    const id = resolve(statement.participant);
    const open = openActivations.get(id) ?? 0;
    if (statement.action === "activate") {
      openActivations.set(id, open + 1);
    } else if (open === 0) {
      diagnostics.push(
        errorDiagnostic(
          `"deactivate ${statement.participant}" has no matching "activate"`,
          DiagnosticCode.UnmatchedDeactivate,
          statement.range,
        ),
      );
    } else {
      openActivations.set(id, open - 1);
    }
  }

  return diagnostics;
}

/** Whether a diagram has no semantic problems. */
export function isValid(diagram: SequenceDiagram): boolean {
  return validateSemantics(diagram).length === 0;
}
