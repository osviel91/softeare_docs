/**
 * Context-aware DSL completion.
 *
 * A static keyword list is not completion — it is a dictionary. What makes this
 * useful is knowing *where* the caret is: after an arrow only a participant can
 * go, inside a fragment a nested fragment or a note can start, and at the top of
 * a document the declarations come first. So the request carries the document and
 * the caret offset, the fragment nesting comes from the parsed AST, and the
 * names come from the project index (participant symbols and resource titles)
 * rather than from the text of one file.
 *
 * The module is pure and framework-free, which keeps the editor component a thin
 * popup and makes the suggestions testable without a browser.
 */
import type { SequenceDiagram } from "../diagram/ast";
import { rangeContainsPosition } from "../../language/source-position";
import type { ProjectSymbol, ResourceDescriptor } from "./project-index";
import { SYMBOL_KIND_LABELS } from "./project-index";
import type { EventFlow } from "../eventflow/ast";
import { brokersOf, channelsOf, eventsOf, servicesOf } from "../eventflow/ast";

/** The kind of thing a suggestion inserts. */
export type CompletionKind =
  | "keyword"
  | "participant"
  | "diagram"
  | "document"
  | "fragment"
  // Event-driven concepts. A separate flavour rather than a reuse of "diagram",
  // so the list can label an event differently from a broker without the caller
  // having to guess from the label.
  | "broker";

/** One suggestion, with the span of text it replaces. */
export interface CompletionItem {
  /** The text shown in the list and inserted by default. */
  label: string;
  kind: CompletionKind;
  /** A short explanation shown beside the label. */
  detail?: string;
  /** What to insert, when it differs from the label. */
  insertText?: string;
  /** The offset range the insertion replaces (the word being typed). */
  replaceStart: number;
  replaceEnd: number;
}

/** Everything completion needs to answer one keystroke. */
export interface CompletionRequest {
  /** The document's current text. */
  source: string;
  /** The caret's 0-based character offset. */
  offset: number;
  /** The document's parsed AST, when it parsed. */
  ast: SequenceDiagram | null;
  /** Participant symbols the project knows about. */
  symbols: ProjectSymbol[];
  /** Resources a diagram may reference. */
  resources: ResourceDescriptor[];
  /** Cap on how many suggestions to return. Defaults to 40. */
  limit?: number;
}

/** Arrow spellings the DSL accepts, longest first (see the lexer). */
const ARROWS = [
  "<<-->>",
  "<<->>",
  "-->>",
  "-->",
  "--x",
  "--)",
  "->>",
  "->",
  "-x",
  "-)",
];

/** Keywords that may start a statement at the top of a document. */
const ROOT_KEYWORDS = [
  "title",
  "participant",
  "actor",
  "alias",
  "note",
  "loop",
  "alt",
  "opt",
  "par",
  "critical",
  "break",
];

/** Keywords that may start a statement inside a control-flow fragment. */
const NESTED_KEYWORDS = [
  "note",
  "loop",
  "alt",
  "opt",
  "par",
  "critical",
  "break",
  "activate",
  "deactivate",
  "end",
];

/** Keywords that close or branch a fragment. */
const FRAGMENT_KEYWORDS = ["else", "and", "option", "end"];

/** The default number of suggestions. */
const DEFAULT_LIMIT = 40;

/** The word being typed immediately before the caret. */
function wordBefore(
  source: string,
  offset: number,
): { start: number; text: string } {
  const before = source.slice(0, offset);
  const match = /[A-Za-z_][\w.-]*$/.exec(before);
  if (!match) return { start: offset, text: "" };
  return { start: offset - match[0].length, text: match[0] };
}

/** The text of the line the caret is on, up to the caret. */
function linePrefix(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const newline = before.lastIndexOf("\n");
  return before.slice(newline + 1);
}

/** Whether the caret sits inside a control-flow fragment. */
function insideFragment(
  ast: SequenceDiagram | null,
  offset: number,
  source: string,
): boolean {
  if (!ast) return false;
  const position = offsetToPositionSafe(source, offset);
  if (!position) return false;
  const walk = (statements: SequenceDiagram["statements"]): boolean => {
    for (const statement of statements) {
      if (
        statement.type === "loop" ||
        statement.type === "opt" ||
        statement.type === "break"
      ) {
        // The header line is the fragment's own start; only lines after it are
        // "inside", so typing a new fragment at the same level is still offered.
        if (
          rangeContainsPosition(statement.range, position) &&
          position.line > statement.range.start.line
        ) {
          return true;
        }
        if (walk(statement.statements)) return true;
      } else if (
        statement.type === "alt" ||
        statement.type === "par" ||
        statement.type === "critical"
      ) {
        if (
          rangeContainsPosition(statement.range, position) &&
          position.line > statement.range.start.line
        ) {
          return true;
        }
        for (const branch of statement.branches) {
          if (walk(branch.statements)) return true;
        }
      }
    }
    return false;
  };
  return walk(ast.statements);
}

/** `offsetToPosition` with the import kept local to avoid a cycle. */
function offsetToPositionSafe(
  source: string,
  offset: number,
): { line: number; column: number } | null {
  if (offset < 0) return null;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let remaining = offset;
  for (let line = 0; line < lines.length; line += 1) {
    const length = lines[line].length;
    if (remaining <= length) return { line, column: remaining };
    remaining -= length + 1;
  }
  return null;
}

/** Whether an arrow ends the prefix, optionally followed by a partial word. */
function afterArrow(prefix: string): boolean {
  // Drop the half-typed name and any spacing the user has already added, so
  // `Cart -> Pay` reads the same as `Cart ->Pay`.
  const trimmed = prefix.replace(/[\w.-]*$/, "").trimEnd();
  return ARROWS.some((arrow) => trimmed.endsWith(arrow));
}

/** The `prefix:<partial>` position a caret can be in. */
type CaretContext =
  | { kind: "participant-name" }
  | { kind: "statement-start"; nested: boolean }
  | { kind: "fragment-branch"; nested: boolean }
  | { kind: "alias-target" }
  | { kind: "none" };

/** Work out what the caret is positioned to type. */
function contextAt(
  prefix: string,
  ast: SequenceDiagram | null,
  source: string,
  offset: number,
): CaretContext {
  const nested = insideFragment(ast, offset, source);

  // Inside a quoted label (`participant api as "…"`) nothing is suggested: the
  // text is prose, not an identifier.
  if (/^\s*(participant|actor)\s+\S+\s+as\s+"/.test(prefix))
    return { kind: "none" };

  // `alias X = ` wants the participant it stands for.
  if (/^\s*alias\s+[^\s=]+\s*=\s*[\w.-]*$/.test(prefix)) {
    return { kind: "alias-target" };
  }

  // A message in progress: the endpoints are participants.
  if (afterArrow(prefix)) return { kind: "participant-name" };

  // `activate`, `deactivate` and a note's anchor all name participants.
  if (/^\s*(activate|deactivate)\s+[\w.-]*$/.test(prefix)) {
    return { kind: "participant-name" };
  }
  if (
    /^\s*(note\s+(left|right)\s+of|note\s+(over|on))\s+[\w.,\s.-]*$/.test(
      prefix,
    )
  ) {
    return { kind: "participant-name" };
  }

  // An indented line inside a fragment is a statement, and fragment keywords can
  // branch or close it.
  if (nested) {
    if (/^\s*(else|and|option)\b/.test(prefix)) {
      return { kind: "fragment-branch", nested: true };
    }
    return { kind: "statement-start", nested: true };
  }

  return { kind: "statement-start", nested: false };
}

/** Build a suggestion, carrying the word span it replaces. */
function item(
  label: string,
  kind: CompletionKind,
  detail: string | undefined,
  span: { start: number; end: number },
): CompletionItem {
  return {
    label,
    kind,
    detail,
    replaceStart: span.start,
    replaceEnd: span.end,
  };
}

/** Filter by the word being typed, most relevant first. */
function filterByPrefix(
  items: CompletionItem[],
  prefix: string,
): CompletionItem[] {
  if (prefix === "") return items;
  const lower = prefix.toLowerCase();
  const starts: CompletionItem[] = [];
  const contains: CompletionItem[] = [];
  for (const entry of items) {
    const label = entry.label.toLowerCase();
    if (label.startsWith(lower)) starts.push(entry);
    else if (label.includes(lower)) contains.push(entry);
  }
  // An exact match wins, then the shortest completion, so `pa` offers `par`
  // before `participant` rather than burying the shorter keyword.
  const byRelevance = (a: CompletionItem, b: CompletionItem): number => {
    if (a.label.toLowerCase() === lower) return -1;
    if (b.label.toLowerCase() === lower) return 1;
    return a.label.length - b.label.length || a.label.localeCompare(b.label);
  };
  return [...starts.sort(byRelevance), ...contains.sort(byRelevance)];
}

/** Participant suggestions, drawn from the project's symbols. */
function participantItems(
  symbols: ProjectSymbol[],
  span: { start: number; end: number },
): CompletionItem[] {
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const symbol of symbols) {
    if (symbol.kind !== "participant" && symbol.kind !== "actor") continue;
    if (seen.has(symbol.name)) continue;
    seen.add(symbol.name);
    const role = symbol.role ? ` · ${symbol.role}` : "";
    items.push(
      item(
        symbol.name,
        "participant",
        `${SYMBOL_KIND_LABELS[symbol.kind]}${role}`,
        span,
      ),
    );
  }
  return items;
}

/** Keyword suggestions for a context. */
function keywordItems(
  keywords: string[],
  kind: CompletionKind,
  detail: string,
  span: { start: number; end: number },
): CompletionItem[] {
  return keywords.map((keyword) => item(keyword, kind, detail, span));
}

/**
 * Suggest completions for the caret.
 *
 * Returns an empty list when the caret is somewhere nothing can be suggested —
 * inside a quoted label, or after a statement's `:` where the rest of the line is
 * prose. A caller can therefore render the popup purely from "are there items".
 */
export function completeAt(request: CompletionRequest): CompletionItem[] {
  const { source, offset, ast } = request;
  const prefix = linePrefix(source, offset);

  // The first `:` on a line is where the DSL stops being structure and starts
  // being text (a message label, a note's body, a fragment's description), so
  // nothing after it is completed.
  const head = prefix.split(":")[0];
  if (head !== prefix) return [];

  // Inside a declaration's quoted label the text is a human name, not an id.
  if (/^\s*(participant|actor)\s+\S+\s+as\s+"/.test(head)) return [];

  const word = wordBefore(source, offset);
  const span = { start: word.start, end: offset };
  const context = contextAt(head, ast, source, offset);
  if (context.kind === "none") return [];

  const limit = request.limit ?? DEFAULT_LIMIT;

  if (context.kind === "participant-name" || context.kind === "alias-target") {
    return filterByPrefix(
      participantItems(request.symbols, span),
      word.text,
    ).slice(0, limit);
  }

  // Keywords are only offered at the start of a statement, never in the middle of
  // one, so a half-typed name is not buried under them.
  if (!/^\s*[\w.-]*$/.test(head)) return [];

  const keywords = context.nested
    ? [...NESTED_KEYWORDS, ...FRAGMENT_KEYWORDS]
    : ROOT_KEYWORDS;
  return filterByPrefix(
    keywordItems(keywords, "keyword", "keyword", span),
    word.text,
  ).slice(0, limit);
}

/** The labels a completion list shows, for a quick summary in tests. */
export function completionLabels(items: CompletionItem[]): string[] {
  return items.map((entry) => entry.label);
}

/** Everything completion needs to answer one keystroke in an event flow. */
export interface EventFlowCompletionRequest {
  source: string;
  /** The caret's 0-based character offset. */
  offset: number;
  /** The document's parsed flow, when it parsed. */
  flow: EventFlow | null;
  /** Names declared elsewhere in the project, so a flow can name them too. */
  projectNames?: {
    events?: string[];
    services?: string[];
    channels?: string[];
    brokers?: string[];
  };
  limit?: number;
}

/** Keywords that may start a statement in an event flow. */
const EVENT_FLOW_KEYWORDS = [
  "title",
  "event",
  "broker",
  "topic",
  "queue",
  "stream",
  "producer",
  "consumer",
  "service",
  "publish",
  "consume",
];

/** Merge name lists, keeping the first occurrence and dropping empties. */
function mergeNames(...lists: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const name of list ?? []) {
      if (name === "" || seen.has(name)) continue;
      seen.add(name);
      merged.push(name);
    }
  }
  return merged;
}

/**
 * Suggest completions for the caret in an event-flow document.
 *
 * The context is read from the sentence being typed, because the language is
 * line-oriented: `publishes` wants an event, `to` wants a channel, `consumes`
 * wants an event, `from` wants a channel. Names come from this document *and*
 * from the rest of the project, so a flow can name an event another flow
 * declares — which is the normal case in a real system and exactly where a
 * static word list would be useless.
 */
export function completeEventFlowAt(
  request: EventFlowCompletionRequest,
): CompletionItem[] {
  const { source, offset, flow } = request;
  const prefix = linePrefix(source, offset);
  const word = wordBefore(source, offset);
  const span = { start: word.start, end: offset };
  const limit = request.limit ?? DEFAULT_LIMIT;

  const local = flow
    ? {
        events: eventsOf(flow).map((event) => event.name),
        services: servicesOf(flow).map((service) => service.name),
        channels: channelsOf(flow).map((channel) => channel.name),
        brokers: brokersOf(flow).map((broker) => broker.name),
      }
    : { events: [], services: [], channels: [], brokers: [] };
  const project = request.projectNames ?? {};

  const named = (kind: CompletionKind, names: string[]): CompletionItem[] =>
    names.map((name) => item(name, kind, undefined, span));

  // The word immediately before the caret sets the context, whether the caret
  // follows a space or is still inside the word. Trimming the prefix first would
  // make `publishes ` look like `publishes` being typed, which shifts the whole
  // reading by one word.
  const afterSpace = /\s$/.test(prefix);
  const words = prefix.trim() === "" ? [] : prefix.trim().split(/\s+/);
  // The word that decides what this position expects. Mid-word it is the word
  // *before* the one being typed (`publishes Pay` still expects an event), and
  // after a space it is the last complete word (`publishes ` does too).
  const contextWord = (
    afterSpace ? words[words.length - 1] : words[words.length - 2]
  )?.toLowerCase();

  // A declaration introduces a *new* name, so the keyword list would be noise
  // there — except for the ones that name an existing service, where picking a
  // known name is exactly what the user wants.
  if (
    contextWord !== undefined &&
    ["title", "event", "broker", "topic", "queue", "stream"].includes(
      contextWord,
    )
  ) {
    return [];
  }

  // `… to <channel>` / `… from <channel>`.
  if (contextWord === "to") {
    return filterByPrefix(
      named("document", mergeNames(local.channels, project.channels)),
      word.text,
    ).slice(0, limit);
  }
  // `from` is ambiguous — `consumes X from <channel>` names a channel, while
  // `publish X from <service>` names a service — so both are offered, and the
  // detail line says which is which.
  if (contextWord === "from") {
    return filterByPrefix(
      [
        ...named("document", mergeNames(local.channels, project.channels)),
        ...named("participant", mergeNames(local.services, project.services)),
      ],
      word.text,
    ).slice(0, limit);
  }
  // `consume X by <service>`.
  if (contextWord === "by") {
    return filterByPrefix(
      named("participant", mergeNames(local.services, project.services)),
      word.text,
    ).slice(0, limit);
  }
  // `topic <name> on <broker>`.
  if (contextWord === "on") {
    return filterByPrefix(
      named("broker", mergeNames(local.brokers, project.brokers)),
      word.text,
    ).slice(0, limit);
  }
  // The verbs take an event, and the declarations take a service.
  if (
    contextWord === "publishes" ||
    contextWord === "consumes" ||
    contextWord === "publish" ||
    contextWord === "consume"
  ) {
    return filterByPrefix(
      named("diagram", mergeNames(local.events, project.events)),
      word.text,
    ).slice(0, limit);
  }
  if (
    contextWord === "producer" ||
    contextWord === "consumer" ||
    contextWord === "service"
  ) {
    return filterByPrefix(
      named("participant", mergeNames(local.services, project.services)),
      word.text,
    ).slice(0, limit);
  }

  // The first word of a statement: the statement keywords.
  if (words.length > 1) return [];
  return filterByPrefix(
    keywordItems(EVENT_FLOW_KEYWORDS, "keyword", "keyword", span),
    word.text,
  ).slice(0, limit);
}
