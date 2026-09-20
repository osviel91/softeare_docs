/**
 * Per-resource analysis: everything the project index knows about one file,
 * computed from that file alone.
 *
 * This is the unit of work the incremental indexer caches, and the reason the
 * index does not have to re-read the whole project when one document is edited.
 * It is a pure function of a descriptor plus content, so it is also the natural
 * seam for a future agent-facing API: "analyse this text as this resource".
 *
 * Analysis never resolves a reference to another resource — that needs the whole
 * project and happens in `project-index.ts`. What it does produce is the
 * *candidate* references, the symbols the file declares, its headings, and the
 * problems that can be judged without looking anywhere else.
 */
import type { SequenceDiagram, SourceRange, Statement } from "../diagram/ast";
import { walkStatements } from "../diagram/ast";
import type {
  ResourceDescriptor,
  ResourceAnalysis,
  ReferenceCandidate,
  ProjectSymbol,
  ProjectSymbolUsage,
  ProjectDiagnostic,
  MarkdownHeading,
} from "./project-index";
import { referenceKindOf } from "./project-index";
import { analyze } from "../../language/analyze";
import { diagramTitle } from "../../language/diagram-title";
import {
  markdownReferences,
  type MarkdownReference,
} from "../../language/markdown/markdown";
import { noteTitle } from "../../language/markdown/note-title";

/** A salt so a change to the analysis rules invalidates cached fingerprints. */
const ANALYSIS_VERSION = "1";

/**
 * A small, fast, non-cryptographic content fingerprint (FNV-1a, 32-bit).
 *
 * The index only needs to answer "is this the same text I analysed before?", and
 * a collision would at worst delay a rebuild until the next edit. Using a hash
 * rather than the text itself keeps the cache from holding a second copy of
 * every document.
 */
export function fingerprintContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${ANALYSIS_VERSION}:${content.length.toString(36)}:${(hash >>> 0).toString(36)}`;
}

/**
 * The architectural role implied by a lifeline's name.
 *
 * The sequence DSL names lifelines but does not classify them, so this is an
 * inference from the name, kept separate from {@link ProjectSymbol.kind} (which
 * is a fact read out of the AST). It exists because an architecture index is far
 * more useful when `PaymentDatabase` is recognisably a database; when the event
 * DSL grows explicit declarations, this heuristic should be replaced by them
 * rather than extended.
 */
export function inferSymbolRole(
  name: string,
): "service" | "database" | "queue" | undefined {
  const value = name.toLowerCase();
  if (/(database|db|repository|repo|store)$/.test(value)) return "database";
  if (/(queue|topic|channel|broker|bus|stream)$/.test(value)) return "queue";
  if (/(service|api|gateway|client|worker|handler|manager)$/.test(value)) {
    return "service";
  }
  return undefined;
}

/** Escape a string for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The span of `name` as a whole word inside `line`, or `null` when absent.
 *
 * The AST records a declaration's and a statement's range, but a range covers
 * the whole construct rather than the participant token inside it. Renaming and
 * hover both need the token, so it is located here — as a whole word, so
 * `Payment` never matches inside `PaymentService`.
 */
function wholeWordSpanInLine(
  line: string,
  name: string,
): { column: number; length: number } | null {
  if (name === "") return null;
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
  const match = pattern.exec(line);
  if (!match) return null;
  return { column: match.index, length: name.length };
}

/** The span of a name on a 0-based source line, for a node at that line. */
function nameRangeOnLine(
  source: string,
  line: number,
  name: string,
): SourceRange | null {
  const text = source.replace(/\r\n?/g, "\n").split("\n")[line];
  if (text === undefined) return null;
  const span = wholeWordSpanInLine(text, name);
  if (!span) return null;
  return {
    start: { line, column: span.column },
    end: { line, column: span.column + span.length },
  };
}

/**
 * The symbols a diagram declares: one per lifeline.
 *
 * The symbol's range is narrowed to the participant's own name rather than the
 * whole declaration line, because that span is what a rename rewrites and what a
 * hover should underline. `sourceRange` is therefore the identifier, while
 * navigation to "the declaration" still lands on the right line.
 */
function diagramSymbols(
  ast: SequenceDiagram,
  source: string,
  resourceId: string,
): ProjectSymbol[] {
  return ast.participants.map((participant) => {
    const symbol: ProjectSymbol = {
      id: `participant:${participant.id}`,
      name: participant.id,
      kind: participant.participantType === "actor" ? "actor" : "participant",
      resourceId,
      sourceRange:
        nameRangeOnLine(source, participant.range.start.line, participant.id) ??
        participant.range,
    };
    const role = inferSymbolRole(participant.label || participant.id);
    if (role) symbol.role = role;
    return symbol;
  });
}

/**
 * Every participant id the diagram references, however it references it.
 *
 * Notes live beside the statement list rather than inside it (they are attached
 * to elements, not executed in sequence), so both are walked here.
 */
function referencedParticipantIds(ast: SequenceDiagram): Set<string> {
  const referenced = new Set<string>();
  for (const statement of walkStatements(ast.statements)) {
    switch (statement.type) {
      case "message":
        referenced.add(statement.from);
        referenced.add(statement.to);
        break;
      case "activation":
        referenced.add(statement.participant);
        break;
      default:
        // A fragment owns no participants of its own; its statements are walked
        // by `walkStatements` above.
        break;
    }
  }
  for (const note of ast.notes) {
    for (const participant of note.participants) {
      referenced.add(participant);
    }
  }
  return referenced;
}

/** A statement that can mention a participant by name, with its source line. */
interface ParticipantMention {
  name: string;
  line: number;
  context: ProjectSymbolUsage["context"];
}

/**
 * Every participant mention a diagram makes, with the line it is on.
 *
 * The AST records which participants a statement *uses* but not the span of each
 * name — the statement's range covers the whole construct. Resolving a rename
 * needs the exact span, so the mention's line is re-read here and the name is
 * located as a whole word in the part of the line that can hold an endpoint.
 *
 * That part is everything before the first `:`, which is where the DSL puts a
 * message label, a note's body and, in an alias, nothing at all. Restricting the
 * search this way is what keeps a rename from rewriting prose: in
 * `A -> B: ask PaymentService`, the label is outside the span considered. Whole-word
 * matching keeps `Payment` from matching inside `PaymentService`.
 */
function participantMentions(ast: SequenceDiagram): ParticipantMention[] {
  const mentions: ParticipantMention[] = [];
  const add = (
    name: string,
    range: { start: { line: number } },
    context: ProjectSymbolUsage["context"],
  ): void => {
    mentions.push({ name, line: range.start.line, context });
  };

  for (const statement of walkStatements(ast.statements)) {
    switch (statement.type) {
      case "message":
        add(statement.from, statement.range, "message");
        add(statement.to, statement.range, "message");
        break;
      case "activation":
        add(statement.participant, statement.range, "activation");
        break;
      default:
        break;
    }
  }
  for (const note of ast.notes) {
    for (const participant of note.participants) {
      add(participant, note.range, "note");
    }
  }
  for (const alias of ast.aliases) {
    add(alias.target, alias.range, "alias");
  }
  return mentions;
}

/**
 * Resolve mentions to exact spans.
 *
 * A mention is looked for as a whole word in the endpoint segment of its line —
 * everything before the first `:` — and one span is produced per occurrence, so
 * a self-message (`A -> A: …`) yields both of its endpoints.
 */
function participantUsages(
  ast: SequenceDiagram,
  source: string,
  resourceId: string,
): ProjectSymbolUsage[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const usages: ProjectSymbolUsage[] = [];
  const seen = new Set<string>();

  for (const mention of participantMentions(ast)) {
    const line = lines[mention.line];
    if (line === undefined || mention.name === "") continue;
    const colon = line.indexOf(":");
    const segment = colon === -1 ? line : line.slice(0, colon);
    const pattern = new RegExp(
      `(?<![\\w$])${escapeRegExp(mention.name)}(?![\\w$])`,
      "g",
    );
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(segment)) !== null) {
      const start = { line: mention.line, column: match.index };
      const end = {
        line: mention.line,
        column: match.index + mention.name.length,
      };
      const key = `${start.line}:${start.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      usages.push({
        resourceId,
        name: mention.name,
        range: { start, end },
        context: mention.context,
      });
    }
  }

  return usages;
}

/** Count the messages in a diagram, including those inside fragments. */
function countMessages(statements: Statement[]): number {
  let count = 0;
  for (const statement of walkStatements(statements)) {
    if (statement.type === "message") count += 1;
  }
  return count;
}

/** Map one language diagnostic onto the project diagnostic shape. */
function diagramDiagnostics(
  ast: SequenceDiagram | null,
  source: string,
  resourceId: string,
): ProjectDiagnostic[] {
  const { diagnostics } = analyze(source);
  const mapped: ProjectDiagnostic[] = diagnostics.map((diagnostic) => ({
    severity: diagnostic.severity,
    message: diagnostic.message,
    resourceId,
    code: diagnostic.code,
    sourceRange: diagnostic.range,
  }));

  if (!ast) return mapped;

  // A declared lifeline that no message, activation or note ever mentions is
  // dead weight in a diagram that is supposed to document behaviour. It is a
  // warning rather than an error: it may be deliberate while a diagram is being
  // written.
  const referenced = referencedParticipantIds(ast);
  for (const participant of ast.participants) {
    if (referenced.has(participant.id)) continue;
    mapped.push({
      severity: "warning",
      message: `Participant "${participant.id}" is declared but never used`,
      resourceId,
      code: "project.unused-participant",
      sourceRange: participant.range,
    });
  }

  return mapped;
}

/** Headings of a markdown document, with the line each starts on. */
function documentHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line, index) => {
      const match = /^(#{1,6})\s+(.*)$/.exec(line);
      if (!match) return;
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        line: index + 1,
      });
    });
  return headings;
}

/** Rough word count, used only for the dashboard's summary line. */
function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Convert a markdown reference into a project reference candidate.
 *
 * An image is a URL to fetch, and a directive naming something we do not know
 * (`{{mermaid:…}}`) is not a project reference either, so both are dropped here
 * rather than reported as broken later. The candidate keeps a source range so a
 * problem found while resolving it can be clicked through to in the editor; the
 * range covers the target as written, which is what the reader needs to see.
 */
function candidateOf(reference: MarkdownReference): ReferenceCandidate | null {
  if (reference.kind === "embed") {
    switch (reference.label.toLowerCase()) {
      case "diagram":
      case "sequence":
      case "doc":
      case "document":
      case "markdown":
        break;
      default:
        return null;
    }
  }
  const kind = referenceKindOf(reference.kind);
  if (!kind) return null;
  const line = reference.line - 1;
  const column = reference.column - 1;
  return {
    kind,
    target: reference.target,
    sourceRange: {
      start: { line, column },
      end: { line, column: column + reference.target.length },
    },
  };
}

/**
 * Analyse one resource.
 *
 * @param descriptor - Its stable identity and current path.
 * @param content - Its text: DSL source or markdown.
 */
export function analyzeResource(
  descriptor: ResourceDescriptor,
  content: string,
): ResourceAnalysis {
  const base = {
    fingerprint: fingerprintContent(content),
    descriptor,
    headings: [] as MarkdownHeading[],
    symbols: [] as ProjectSymbol[],
    usages: [] as ProjectSymbolUsage[],
    references: [] as ReferenceCandidate[],
    diagnostics: [] as ProjectDiagnostic[],
    metrics: { participants: 0, messages: 0, words: 0 },
  };

  if (descriptor.type === "sequence-diagram") {
    const { ast } = analyze(content);
    const declaredTitle = diagramTitle(content);
    return {
      ...base,
      descriptor: {
        ...descriptor,
        title: declaredTitle ?? descriptor.path,
      },
      declaredTitle,
      symbols: ast ? diagramSymbols(ast, content, descriptor.id) : [],
      usages: ast ? participantUsages(ast, content, descriptor.id) : [],
      diagnostics: diagramDiagnostics(ast, content, descriptor.id),
      metrics: {
        participants: ast?.participants.length ?? 0,
        messages: ast ? countMessages(ast.statements) : 0,
        words: 0,
      },
    };
  }

  const headings = documentHeadings(content);
  const references = markdownReferences(content)
    .map(candidateOf)
    .filter((candidate): candidate is ReferenceCandidate => candidate !== null);
  const declaredTitle = noteTitle(content);

  return {
    ...base,
    descriptor: {
      ...descriptor,
      title: declaredTitle ?? descriptor.path,
    },
    declaredTitle,
    headings,
    references,
    diagnostics: [],
    metrics: { participants: 0, messages: 0, words: wordCount(content) },
  };
}
