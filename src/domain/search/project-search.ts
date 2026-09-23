/**
 * Project-wide content search.
 *
 * The workspace index knows every document's text; this module finds a query
 * inside it. It is intentionally pure and content-agnostic — a document is a
 * title, some text, and an optional set of named facets — so the same scan serves
 * diagrams (DSL) and markdown today and event flows later, without the search
 * layer learning any language.
 *
 * A query is a string of whitespace-separated tokens. Plain words are matched
 * case-insensitively against the document's searchable signals; the prefixed tokens
 * `kind:`/`type:`, `project:`, `participant:` and `tag:` narrow which documents are considered
 * before the text is scanned. A filter-only query (for example
 * `participant:PaymentService`) lists the documents that match it, which is how
 * the panel answers "where is this participant used?".
 *
 * Matches are reported with a line, column, and character offset so the UI can
 * both show where the hit is and put the caret on it.
 */
import type { ResourceKind } from "../workspace/resource";
import type { ResourceRepresentation } from "../workspace/resource-id";
import type { ResourceMetadata } from "../workspace/resource-metadata";

/**
 * One searchable document.
 *
 * `content` is the whole file — DSL source or markdown — because offsets are
 * reported against it and the editor selects them directly.
 */
export interface SearchDocument {
  /** Which kind of resource this document is. */
  kind: ResourceKind;
  /** How the document content is interpreted, when known. */
  representation?: ResourceRepresentation;
  /** Stable id of the backing file. */
  id: string;
  /** The project the file belongs to. */
  projectId: string;
  /** The project's display name, for grouping results. */
  projectName: string;
  /** The file name. */
  name: string;
  /** The document's display title (a diagram `title`, a document's first heading). */
  title: string;
  /** The full text: DSL source or markdown. */
  content: string;
  /** Stored semantic metadata, already normalized by the workspace boundary. */
  metadata?: ResourceMetadata;
  /**
   * Named entities the document declares, for scoped queries. Today only
   * participants; the shape deliberately leaves room for the event concepts
   * (events, producers, consumers) without changing the callers.
   */
  facets?: { participants?: string[] };
}

/** A single hit inside a document. */
export interface SearchMatch {
  kind: ResourceKind;
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  title: string;
  /** Bounded semantic context for callers that want to explain the hit. */
  metadata?: ResourceMetadata;
  /** 1-based line number of the match. */
  line: number;
  /** 1-based column number of the match within its line. */
  column: number;
  /** 0-based character offset of the match within the document. */
  offset: number;
  /** Length of the matched text; 0 for a document-level (filter-only) match. */
  length: number;
  /** The matched text itself, so a caller can verify it found the right range. */
  text: string;
  /** The trimmed line containing the match, for display. */
  excerpt: string;
  /** The searchable signals that caused this result. */
  matchedFields: SearchMatchField[];
}

/** Searchable signals exposed for lightweight result explainability. */
export type SearchMatchField =
  "name" | "title" | "description" | "tags" | "content";

/** A parsed query: free text plus the document filters. */
export interface SearchQuery {
  /** Free text matched case-insensitively against the content (may be empty). */
  text: string;
  /** When present, only these resource kinds are searched. */
  kinds?: ResourceKind[];
  /** When present, only documents in a project whose name/id contains this. */
  project?: string;
  /** When present, only documents declaring a participant matching this. */
  participant?: string;
  /** When present, all of these normalized tags must be present. */
  tags?: string[];
}

/** Limits that keep a broad query from flooding the panel. */
export interface SearchOptions {
  /** Stop after this many matches. Defaults to 200. */
  limit?: number;
  /** Longest excerpt kept per match, in characters. Defaults to 160. */
  excerptLength?: number;
}

/** The default match cap. */
export const DEFAULT_SEARCH_LIMIT = 200;
/** The default excerpt length. */
export const DEFAULT_EXCERPT_LENGTH = 160;

/** The resource kinds a `kind:` token may name. */
const RESOURCE_KINDS: ResourceKind[] = ["diagram", "note"];

/** Whether `value` is one of the known resource kinds. */
function isResourceKind(value: string): value is ResourceKind {
  return (RESOURCE_KINDS as string[]).includes(value);
}

/**
 * Parse a raw query string into text and filters.
 *
 * `kind:` and `type:` accept `diagram` and `note` (anything else is treated as plain text,
 * so a stray colon never silently swallows the query). A bare word containing a
 * colon is left alone unless it starts with one of the known field names.
 */
export function parseSearchQuery(input: string): SearchQuery {
  const words: string[] = [];
  const kinds: ResourceKind[] = [];
  let project: string | undefined;
  let participant: string | undefined;
  const tags: string[] = [];

  for (const token of input.trim().split(/\s+/)) {
    if (token === "") continue;
    const match = /^(kind|type|project|participant|tag):(.*)$/i.exec(token);
    const value = match?.[2].trim() ?? "";
    if (!match || value === "") {
      words.push(token);
      continue;
    }
    switch (match[1].toLowerCase()) {
      case "kind":
      case "type":
        if (isResourceKind(value.toLowerCase())) {
          kinds.push(value.toLowerCase() as ResourceKind);
        } else {
          words.push(token);
        }
        break;
      case "project":
        project = value;
        break;
      case "participant":
        participant = value;
        break;
      case "tag":
        tags.push(value.toLowerCase());
        break;
    }
  }

  const query: SearchQuery = { text: words.join(" ") };
  if (kinds.length > 0) query.kinds = kinds;
  if (project !== undefined) query.project = project;
  if (participant !== undefined) query.participant = participant;
  if (tags.length > 0) query.tags = tags;
  return query;
}

/** Whether `value` contains `needle`, case-insensitively. */
function contains(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle);
}

/** Whether a document satisfies the query's filters (ignoring free text). */
function matchesFilters(document: SearchDocument, query: SearchQuery): boolean {
  if (query.kinds && !query.kinds.includes(document.kind)) return false;
  if (
    query.project !== undefined &&
    !contains(document.projectName, query.project.toLowerCase()) &&
    !contains(document.projectId, query.project.toLowerCase())
  ) {
    return false;
  }
  if (query.participant !== undefined) {
    const wanted = query.participant.toLowerCase();
    const participants = document.facets?.participants ?? [];
    if (!participants.some((name) => name.toLowerCase().includes(wanted))) {
      return false;
    }
  }
  if (
    query.tags &&
    !query.tags.every((wanted) =>
      (document.metadata?.tags ?? []).some(
        (tag) => tag.toLowerCase() === wanted,
      ),
    )
  ) {
    return false;
  }
  return true;
}

/** The part of a match that identifies the document it came from. */
function identityOf(document: SearchDocument) {
  const description = document.metadata?.description?.slice(0, 160);
  return {
    kind: document.kind,
    id: document.id,
    projectId: document.projectId,
    projectName: document.projectName,
    name: document.name,
    title: document.title,
    metadata:
      description || document.metadata?.tags?.length
        ? {
            ...(description ? { description } : {}),
            ...(document.metadata?.tags?.length
              ? {
                  tags: document.metadata.tags
                    .slice(0, 32)
                    .map((tag) => tag.slice(0, 80)),
                }
              : {}),
          }
        : undefined,
    matchedFields: [],
  };
}

/**
 * A window around a match, so a long line still shows the hit.
 *
 * A short line is returned trimmed and whole; a long one is cut to a window
 * around the match with ellipses marking where it was cut.
 */
function excerptOf(line: string, at: number, maxLength: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const start = Math.max(0, at - Math.floor(maxLength / 3));
  const end = Math.min(line.length, start + maxLength);
  const slice = line.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${slice}${end < line.length ? "…" : ""}`;
}

/** Every occurrence of `needle` (already lowercased) inside one document. */
function contentMatches(
  document: SearchDocument,
  needle: string,
  excerptLength: number,
): SearchMatch[] {
  const found: SearchMatch[] = [];
  const lines = document.content.replace(/\r\n?/g, "\n").split("\n");
  let offset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const haystack = line.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      found.push({
        ...identityOf(document),
        line: index + 1,
        column: at + 1,
        offset: offset + at,
        length: needle.length,
        text: line.slice(at, at + needle.length),
        excerpt: excerptOf(line, at, excerptLength),
        matchedFields: ["content"],
      });
      from = at + needle.length;
    }
    offset += line.length + 1;
  }

  return found;
}

/** One bounded, document-level hit for a metadata signal. */
function metadataMatch(
  document: SearchDocument,
  field: SearchMatchField,
  value: string,
  needle: string,
  excerptLength: number,
): SearchMatch | undefined {
  const at = value.toLowerCase().indexOf(needle);
  if (at === -1) return undefined;
  const line = value.slice(0, at).split(/\r\n?|\n/).length;
  const lineStart = value.lastIndexOf("\n", at - 1) + 1;
  const lineText = value.slice(lineStart).split(/\r\n?|\n/)[0];
  return {
    ...identityOf(document),
    line,
    column: at - lineStart + 1,
    offset: 0,
    length: 0,
    text: value.slice(at, at + needle.length),
    excerpt: excerptOf(lineText, at - lineStart, excerptLength),
    matchedFields: [field],
  };
}

/** Search metadata without introducing a separate persistent index. */
function metadataMatches(
  document: SearchDocument,
  needle: string,
  excerptLength: number,
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const fields: Array<[SearchMatchField, string]> = [
    ["name", document.name],
    ["title", document.title],
    ["description", document.metadata?.description ?? ""],
  ];
  for (const [field, value] of fields) {
    const match = metadataMatch(document, field, value, needle, excerptLength);
    if (match) matches.push(match);
  }
  for (const tag of document.metadata?.tags ?? []) {
    const match = metadataMatch(document, "tags", tag, needle, excerptLength);
    if (match) matches.push(match);
  }
  return matches;
}

/**
 * Run a parsed query over a set of documents.
 *
 * Returns at most {@link SearchOptions.limit} matches, in document order and
 * then in source order. An empty query with no filters matches nothing, so an
 * untouched search box does not list the whole workspace.
 */
export function searchProject(
  documents: SearchDocument[],
  query: SearchQuery,
  options: SearchOptions = {},
): SearchMatch[] {
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const excerptLength = options.excerptLength ?? DEFAULT_EXCERPT_LENGTH;
  const needle = query.text.trim().toLowerCase();
  const hasFilter =
    (query.kinds?.length ?? 0) > 0 ||
    query.project !== undefined ||
    query.participant !== undefined ||
    (query.tags?.length ?? 0) > 0;
  if (needle === "" && !hasFilter) return [];

  const matches: SearchMatch[] = [];
  for (const document of documents) {
    if (!matchesFilters(document, query)) continue;
    if (needle === "") {
      // A filter-only query lists the documents it matches rather than a line.
      matches.push({
        ...identityOf(document),
        line: 1,
        column: 1,
        offset: 0,
        length: 0,
        text: "",
        excerpt: document.title,
      });
    } else {
      const contentHits = contentMatches(document, needle, excerptLength);
      const metadataHits = metadataMatches(document, needle, excerptLength);
      if (contentHits.length > 0) {
        const metadataFields = metadataHits.flatMap(
          (match) => match.matchedFields,
        );
        if (metadataFields.length > 0) {
          contentHits[0].matchedFields = [
            ...new Set([...contentHits[0].matchedFields, ...metadataFields]),
          ];
        }
        matches.push(...contentHits);
      } else {
        matches.push(...metadataHits);
      }
    }
    if (matches.length >= limit) return matches.slice(0, limit);
  }
  return matches;
}

/** Parse `input` and search `documents` in one step. */
export function runSearch(
  documents: SearchDocument[],
  input: string,
  options: SearchOptions = {},
): SearchMatch[] {
  return searchProject(documents, parseSearchQuery(input), options);
}
