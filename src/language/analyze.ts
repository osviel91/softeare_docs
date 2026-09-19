/**
 * High-level entry point for the language layer.
 *
 * `analyze` runs the full pipeline for a document: lex + parse (syntax) then
 * semantic validation, and returns their combined diagnostics. This is the
 * function the editor calls on every keystroke.
 */
import type { SequenceDiagram } from "../domain/diagram/ast";
import type { ParseResult } from "./diagnostics/diagnostics";
import { parse } from "./parser/parser";
import { validateSemantics } from "./validator/validator";

/** Parse and semantically validate a document, merging all diagnostics. */
export function analyze(source: string): ParseResult<SequenceDiagram> {
  const { ast, diagnostics: syntaxDiagnostics } = parse(source);

  // If parsing could not produce a coherent tree, skip semantic validation.
  if (ast === null) {
    return { ast: null, diagnostics: syntaxDiagnostics };
  }

  const semanticDiagnostics = validateSemantics(ast);
  return {
    ast,
    diagnostics: [...syntaxDiagnostics, ...semanticDiagnostics],
  };
}
