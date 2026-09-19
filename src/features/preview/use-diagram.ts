/**
 * Shared diagram analysis hook (Phase 3).
 *
 * Memoizes {@link analyze} over the source so both the editor and the preview
 * derive from a single computation instead of re-parsing on every render.
 */
import { useMemo } from "react";
import type { SequenceDiagram } from "../../domain/diagram/ast";
import type {
  Diagnostic,
  ParseResult,
} from "../../language/diagnostics/diagnostics";
import { analyze } from "../../language/analyze";

/** The analysis result shared by the editor and preview panes. */
export interface DiagramAnalysis {
  ast: SequenceDiagram | null;
  diagnostics: Diagnostic[];
}

/** Parse + validate DSL source once, memoized over the source string. */
export function useDiagram(source: string): DiagramAnalysis {
  return useMemo<ParseResult<SequenceDiagram>>(() => analyze(source), [source]);
}
