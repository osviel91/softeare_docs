/**
 * Diagnostics produced by the language layer.
 *
 * A {@link Diagnostic} may be tied to a source span (syntax errors) or be
 * context-aware and range-less (semantic errors that are easier to report at a
 * statement than at a precise character range). The `code` lets the UI style or
 * translate errors consistently.
 */
import type { SourceRange } from "../../domain/diagram/ast";

/** How serious a diagnostic is. */
export type DiagnosticSeverity = "error" | "warning" | "info";

/** Stable, machine-readable diagnostic identifiers. */
export enum DiagnosticCode {
  /** Unexpected token while reading a line. */
  UnexpectedToken = "seq.unexpected-token",
  /** A line did not match any supported construct. */
  UnsupportedSyntax = "seq.unsupported-syntax",
  /** A message references a participant that was never declared. */
  UnknownParticipant = "seq.unknown-participant",
  /** The same participant id was declared more than once. */
  DuplicateParticipant = "seq.duplicate-participant",
  /** A message is missing its receiver or label terminator. */
  MalformedMessage = "seq.malformed-message",
  /** A construct appeared where participants must be declared. */
  StatementBeforeParticipant = "seq.statement-before-participant",
  /** An alias was declared after a message; aliases must precede messages. */
  AliasBeforeMessage = "seq.alias-before-message",
  /** An alias references a participant that was never declared. */
  UnknownAliasTarget = "seq.unknown-alias-target",
  /** A `note` line is missing its placement, target, or text terminator. */
  MalformedNote = "seq.malformed-note",
  /** An `activate` / `deactivate` line is missing its participant target. */
  MalformedActivation = "seq.malformed-activation",
  /** A `deactivate` has no matching open `activate` for that participant. */
  UnmatchedDeactivate = "seq.unmatched-deactivate",
  /** A diagram declares more than one `title`. */
  DuplicateTitle = "seq.duplicate-title",
  /** A fragment was opened but never closed with `end`. */
  UnclosedFragment = "seq.unclosed-fragment",
  /** A fragment header is missing its description or is otherwise malformed. */
  MalformedFragment = "seq.malformed-fragment",
  /** An `end`/`else`/`and`/`option` appeared with no fragment to attach to. */
  UnexpectedFragmentKeyword = "seq.unexpected-fragment-keyword",
  /** A participant/actor declaration is missing its name or has trailing text. */
  MalformedParticipant = "seq.malformed-participant",
  /** A `note over A,B` spans fewer than two distinct participants. */
  MalformedSpanningNote = "seq.malformed-spanning-note",
  /** A `note on <n>` names a message number the diagram does not have. */
  UnknownMessageNumber = "seq.unknown-message-number",
}

/** A single diagnostic message with optional source location. */
export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  code: DiagnosticCode;
  /** Present for syntax errors tied to a span; absent for some semantics. */
  range?: SourceRange;
}

/** The outcome of parsing: a best-effort AST plus all diagnostics found. */
export interface ParseResult<T> {
  /**
   * The parsed AST, or `null` when syntax errors prevented building a coherent
   * tree. Semantic problems still return the AST so the UI can validate it.
   */
  ast: T | null;
  diagnostics: Diagnostic[];
}

/** Create an error diagnostic tied to a source span. */
export function errorDiagnostic(
  message: string,
  code: DiagnosticCode,
  range: SourceRange,
): Diagnostic {
  return { severity: "error", message, code, range };
}

/** Create a range-less semantic diagnostic. */
export function semanticDiagnostic(
  message: string,
  code: DiagnosticCode,
): Diagnostic {
  return { severity: "error", message, code };
}

/** Format a range-bearing diagnostic as `Line L, column C` for display. */
export function formatLocation(range: SourceRange): string {
  const { line, column } = range.start;
  // Human-facing line numbers are one-based.
  return `Line ${line + 1}, column ${column + 1}`;
}

/** Format a diagnostic for display, including its location when available. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.range
    ? `${formatLocation(diagnostic.range)}\n`
    : "";
  return `${location}${diagnostic.message}`;
}
