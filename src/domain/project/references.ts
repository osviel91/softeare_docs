/**
 * Find-references and semantic rename.
 *
 * Both work from the project index alone — the index already knows every
 * declaration (`ProjectSymbol`) and every place a name is written
 * (`ProjectSymbolUsage`), each with an exact source span. That is what makes
 * rename *semantic* rather than a global text replace: a rename rewrites the
 * spans the parser and the analyser identified, and nothing else. Prose that
 * happens to mention the same word is untouched.
 *
 * Scope is one project. Because each diagram is self-contained (it declares its
 * own lifelines), a participant name means the same documented thing wherever it
 * appears in the project, so renaming it everywhere it is declared or used is
 * well defined. When a shared architecture model arrives, this is the function
 * that would narrow to it.
 */
import { positionToOffset } from "../../language/source-position";
import type { ProjectIndex } from "./project-index";
import type { ResourceId } from "../workspace/resource-id";

/** One place a symbol's name appears. */
export interface SymbolReferenceSite {
  resourceId: ResourceId;
  /** The file the site is in, for display. */
  resourcePath: string;
  /** The resource's display title. */
  resourceTitle: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** Whether the name is declared here or merely used. */
  role: "declaration" | "usage";
  /** What kind of thing writes the name here. */
  context: string;
}

/** The answer to "where is this symbol used?". */
export interface FindReferencesResult {
  name: string;
  /** Every site, declarations first, then usages in index order. */
  sites: SymbolReferenceSite[];
  /** The resources that declare the symbol. */
  declaredIn: ResourceId[];
}

/**
 * Every declaration and usage of a participant name across the project.
 *
 * The search is exact and case-sensitive: participant ids are identifiers, and
 * matching them loosely would rewrite the wrong thing.
 */
export function findSymbolReferences(
  index: ProjectIndex,
  name: string,
): FindReferencesResult {
  const byId = new Map(
    index.resources.map((resource) => [resource.id, resource]),
  );
  const site = (
    resourceId: ResourceId,
    line: number,
    column: number,
    role: SymbolReferenceSite["role"],
    context: string,
  ): SymbolReferenceSite => ({
    resourceId,
    resourcePath: byId.get(resourceId)?.path ?? resourceId,
    resourceTitle: byId.get(resourceId)?.title ?? resourceId,
    line,
    column,
    role,
    context,
  });

  const declarations = index.participants
    .filter(
      (symbol) => symbol.name === name && symbol.sourceRange !== undefined,
    )
    .map((symbol) =>
      site(
        symbol.resourceId,
        symbol.sourceRange!.start.line + 1,
        symbol.sourceRange!.start.column + 1,
        "declaration",
        symbol.kind,
      ),
    );

  const usages = index.usages
    .filter((usage) => usage.name === name)
    .map((usage) =>
      site(
        usage.resourceId,
        usage.range.start.line + 1,
        usage.range.start.column + 1,
        "usage",
        usage.context,
      ),
    );

  return {
    name,
    sites: [...declarations, ...usages],
    declaredIn: [
      ...new Set(declarations.map((entry) => entry.resourceId)),
    ].sort(),
  };
}

/** One resource's rewritten text after a rename. */
export interface SymbolRenameEdit {
  resourceId: ResourceId;
  /** The file name, for the repository call that persists the change. */
  path: string;
  /** The full new content of the file. */
  content: string;
  /** How many spans this file had rewritten. */
  replaced: number;
}

/** A rename, planned but not yet applied. */
export interface SymbolRenamePlan {
  from: string;
  to: string;
  edits: SymbolRenameEdit[];
  /** The total number of spans rewritten across the project. */
  replaced: number;
  /** Whether the rename touches more than one resource. */
  projectWide: boolean;
}

/** Whether a name is usable as a DSL identifier. */
export function isValidSymbolName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name);
}

/**
 * Plan a rename of a participant name across the project.
 *
 * Spans are replaced from the end of the file backwards, so an earlier edit
 * never shifts the offsets of a later one. A span that would fall outside the
 * text (a stale index) is skipped rather than corrupting the document.
 *
 * @param contents - The current text of every resource that may change, keyed by
 *   resource id. A resource missing from the map is left alone, so a caller can
 *   rename within a subset (for example only the open document).
 */
export function planSymbolRename(
  index: ProjectIndex,
  contents: Map<ResourceId, string>,
  from: string,
  to: string,
): SymbolRenamePlan {
  const spans = new Map<ResourceId, Array<{ start: number; end: number }>>();

  const record = (
    resourceId: ResourceId,
    range: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    },
  ): void => {
    const text = contents.get(resourceId);
    if (text === undefined) return;
    const start = positionToOffset(text, range.start);
    const end = positionToOffset(text, range.end);
    if (end <= start || end > text.length) return;
    const list = spans.get(resourceId) ?? [];
    list.push({ start, end });
    spans.set(resourceId, list);
  };

  for (const symbol of index.participants) {
    if (symbol.name !== from || !symbol.sourceRange) continue;
    record(symbol.resourceId, symbol.sourceRange);
  }
  for (const usage of index.usages) {
    if (usage.name !== from) continue;
    record(usage.resourceId, usage.range);
  }

  const edits: SymbolRenameEdit[] = [];
  let replaced = 0;
  for (const [resourceId, list] of spans) {
    const text = contents.get(resourceId);
    const resource = index.resources.find((entry) => entry.id === resourceId);
    if (text === undefined || !resource) continue;
    // Later spans first, so replacing one does not move the next.
    const ordered = [...list].sort((a, b) => b.start - a.start);
    let next = text;
    for (const span of ordered) {
      next = `${next.slice(0, span.start)}${to}${next.slice(span.end)}`;
      replaced += 1;
    }
    edits.push({
      resourceId,
      path: resource.path,
      content: next,
      replaced: ordered.length,
    });
  }

  return {
    from,
    to,
    edits,
    replaced,
    projectWide: edits.length > 1,
  };
}
