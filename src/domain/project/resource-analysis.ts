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
import type { SequenceDiagram, Statement } from "../diagram/ast";
import { walkStatements } from "../diagram/ast";
import {
  collectParticipantMentions,
  participantUsagesOf,
} from "../diagram/participant-mentions";
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
import {
  analyzeEventFlow,
  type EventFlowDiagnostic,
} from "../../language/eventflow/parser";
import {
  brokersOf,
  channelsOf,
  eventsOf,
  publicationsOf,
  servicesOf,
  subscriptionsOf,
} from "../eventflow/ast";
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

/**
 * The symbols a diagram declares: one per lifeline.
 *
 * The symbol's range is narrowed to the participant's own name rather than the
 * whole declaration line, because that span is what a rename rewrites and what a
 * hover should underline. `sourceRange` is therefore the identifier, while
 * navigation to "the declaration" still lands on the right line. The span comes
 * from the one module that defines where a participant name is written, so the
 * index, the editor's highlight and live rename cannot disagree about it.
 */
function diagramSymbols(
  ast: SequenceDiagram,
  source: string,
  resourceId: string,
): ProjectSymbol[] {
  const declarations = collectParticipantMentions(ast, source).filter(
    (mention) => mention.context === "declaration",
  );
  return ast.participants.map((participant) => {
    const declaration = declarations.find(
      (mention) => mention.range.start.line === participant.range.start.line,
    );
    const symbol: ProjectSymbol = {
      id: `participant:${participant.id}`,
      name: participant.id,
      kind: participant.participantType === "actor" ? "actor" : "participant",
      resourceId,
      sourceRange: declaration?.range ?? participant.range,
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

/**
 * Every participant usage in a diagram, with the exact span it occupies.
 *
 * A usage is any mention other than the declaration itself — a message's two
 * endpoints, an activation, a note anchor or an alias target — located by the
 * shared participant-mention module, so find-references, semantic rename and
 * the editor's live rename all rewrite precisely the same spans.
 */
function participantUsages(
  ast: SequenceDiagram,
  source: string,
  resourceId: string,
): ProjectSymbolUsage[] {
  return participantUsagesOf(ast, source).map((mention) => ({
    resourceId,
    name: mention.name,
    range: mention.range,
    context: mention.context,
  }));
}

/** Map one event-flow diagnostic onto the project diagnostic shape. */
function eventFlowDiagnostic(
  diagnostic: EventFlowDiagnostic,
  resourceId: string,
): ProjectDiagnostic {
  return {
    severity: diagnostic.severity,
    message: diagnostic.message,
    resourceId,
    code: String(diagnostic.code),
    sourceRange: diagnostic.range,
  };
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
        events: 0,
        producers: 0,
        consumers: 0,
        channels: 0,
      },
    };
  }

  if (descriptor.type === "event-flow") {
    const { flow, diagnostics } = analyzeEventFlow(content);
    const publications = publicationsOf(flow);
    const subscriptions = subscriptionsOf(flow);
    // A service counts as a producer/consumer when it actually publishes or
    // consumes, not merely because the document declares it with that role —
    // the diagram is a picture of behaviour, and the counts should match it.
    const producers = new Set(publications.map((entry) => entry.producer));
    const consumers = new Set(subscriptions.map((entry) => entry.consumer));
    const declaredTitle = flow.title?.value;

    const symbols: ProjectSymbol[] = [
      ...eventsOf(flow).map((event) => ({
        id: `event:${event.name}`,
        name: event.name,
        kind: "event" as const,
        resourceId: descriptor.id,
        sourceRange: event.range,
      })),
      ...servicesOf(flow).map((service) => {
        const symbol: ProjectSymbol = {
          id: `service:${service.name}`,
          name: service.name,
          kind: "service",
          resourceId: descriptor.id,
          sourceRange: service.range,
        };
        if (producers.has(service.name)) symbol.role = "producer";
        else if (consumers.has(service.name)) symbol.role = "consumer";
        return symbol;
      }),
      ...channelsOf(flow).map((channel) => {
        const symbol: ProjectSymbol = {
          id: `channel:${channel.name}`,
          name: channel.name,
          kind: "channel",
          resourceId: descriptor.id,
          sourceRange: channel.range,
          // The channel's flavour is a role, so `kind` stays the stable
          // "channel" and a topic is still findable as a channel.
          role: channel.channelKind,
        };
        return symbol;
      }),
      ...brokersOf(flow).map((broker) => ({
        id: `broker:${broker.name}`,
        name: broker.name,
        kind: "broker" as const,
        resourceId: descriptor.id,
        sourceRange: broker.range,
      })),
    ];

    return {
      ...base,
      descriptor: {
        ...descriptor,
        title: declaredTitle ?? descriptor.path,
      },
      declaredTitle,
      symbols,
      usages: [],
      diagnostics: diagnostics.map((diagnostic) =>
        eventFlowDiagnostic(diagnostic, descriptor.id),
      ),
      metrics: {
        participants: 0,
        messages: publications.length + subscriptions.length,
        words: 0,
        events: eventsOf(flow).length,
        producers: producers.size,
        consumers: consumers.size,
        channels: channelsOf(flow).length,
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
    metrics: {
      participants: 0,
      messages: 0,
      words: wordCount(content),
      events: 0,
      producers: 0,
      consumers: 0,
      channels: 0,
    },
  };
}
