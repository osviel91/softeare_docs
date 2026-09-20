/**
 * The project index: a derived, rebuildable description of everything a project
 * contains.
 *
 * The files stay the source of truth. This module never reads storage and never
 * parses anything — it takes the per-resource analyses (see
 * `resource-analysis.ts`) plus the project's identity metadata and assembles the
 * project-wide view: which resources exist, what symbols they declare, how they
 * refer to each other, and what is wrong with them.
 *
 * Splitting it that way is what keeps the index cheap to keep current: editing
 * one file re-analyses one file, and only the assembly below (which touches no
 * text) runs again. It is also what makes the index usable by something that is
 * not the browser UI — an MCP tool server, a test, an export job — because it is
 * a pure function of plain data.
 *
 * References are resolved in two tiers: a stable `resource://`-style scheme is
 * resolved through the project's identity metadata and therefore survives renames
 * and moves, while a bare path or wiki-link name is resolved against the current
 * file tree for compatibility with documents written before ids existed.
 */
import type { SourceRange } from "../diagram/ast";
import {
  duplicateResourceIds,
  resourceRecordById,
  type ProjectMetadata,
} from "../workspace/metadata";
import {
  normalizePath,
  directoryOf,
  isExternalHref,
  basenameOf,
} from "../workspace/project-link";
import type { ResourceId, ResourceType } from "../workspace/resource-id";
import type { MarkdownReferenceKind } from "../../language/markdown/markdown";

/** A resource as the index describes it: stable identity plus current location. */
export interface ResourceDescriptor {
  /** The stable id documentation refers to. */
  id: ResourceId;
  /** The project this resource belongs to. */
  projectId: string;
  /** Where the resource lives now (its file name / project-relative path). */
  path: string;
  /** What the resource is. */
  type: ResourceType;
  /** The display title (a diagram `title`, a document's first heading). */
  title: string;
}

/** A sequence diagram, with the shape facts navigation and hover need. */
export interface DiagramDescriptor extends ResourceDescriptor {
  type: "sequence-diagram";
  /** How many lifelines the diagram declares. */
  participants: number;
  /** How many messages it contains, nested fragments included. */
  messages: number;
  /** Whether it declares a title of its own. */
  titled: boolean;
}

/** A markdown document, with the headings its outline is built from. */
export interface DocumentDescriptor extends ResourceDescriptor {
  type: "markdown-document";
  headings: MarkdownHeading[];
  /** Approximate word count, for the dashboard. */
  words: number;
}

/** One heading of a markdown document. */
export interface MarkdownHeading {
  level: number;
  text: string;
  /** 1-based line number, so the outline can navigate to it. */
  line: number;
}

/**
 * What a symbol is.
 *
 * The set is deliberately open-ended: `service`, `database` and `queue` are
 * already meaningful for the participant flavours this DSL distinguishes by
 * name, and the event-driven kinds (`event`, `producer`, `consumer`, `channel`,
 * `consumer-group`, `schema`) slot in beside them without changing the shape of
 * a symbol or of anything that consumes the index.
 */
export type SymbolKind =
  | "participant"
  | "actor"
  | "service"
  | "database"
  | "queue"
  | "diagram"
  | "document";

/** A symbol declared by, or naming, a resource. */
export interface ProjectSymbol {
  /** A stable, human-readable key: `<kind>:<name>`. */
  id: string;
  name: string;
  kind: SymbolKind;
  /** The resource the symbol belongs to (where it is declared). */
  resourceId: ResourceId;
  /** Where it is declared, when the analysis knows. */
  sourceRange?: SourceRange;
  /**
   * The architectural role inferred from the symbol's name — see
   * `inferSymbolRole`. Kept apart from {@link kind}, which is read out of the
   * AST, so an inference is never mistaken for a declaration.
   */
  role?: "service" | "database" | "queue";
}

/**
 * One place a symbol's name is written.
 *
 * Declarations live in {@link ProjectSymbol}; usages live here so find-references
 * and semantic rename can work from the index alone, without re-parsing or
 * scanning text for the name.
 */
export interface ProjectSymbolUsage {
  /** The resource the usage is written in. */
  resourceId: ResourceId;
  /** The participant name as written. */
  name: string;
  /** The exact span of the name, so a rename can rewrite precisely it. */
  range: SourceRange;
  /** What kind of statement mentions it. */
  context: "message" | "activation" | "note" | "alias";
}

/** How one resource refers to another. */
export type ReferenceKind =
  "diagram-link" | "wiki-link" | "resource-link" | "diagram-ref" | "embed";

/** A resolved (or unresolved) reference from one resource to another. */
export interface ProjectReference {
  /** The resource the reference is written in. */
  from: ResourceId;
  /** The resource it resolves to, or `null` when it does not resolve. */
  to: ResourceId | null;
  kind: ReferenceKind;
  /** The target exactly as written, for diagnostics and display. */
  raw: string;
  sourceRange?: SourceRange;
  /**
   * Why an unresolved reference did not resolve. Kept here rather than recomputed
   * by the validator so resolution happens exactly once per build.
   */
  problem?: { reason: "external" | "missing" | "wrong-kind"; detail: string };
}

/** How serious a project diagnostic is. */
export type ProjectDiagnosticSeverity = "error" | "warning" | "info";

/** A problem found in a project, addressed to a resource and optionally a span. */
export interface ProjectDiagnostic {
  severity: ProjectDiagnosticSeverity;
  message: string;
  resourceId: ResourceId;
  sourceRange?: SourceRange;
  /** Machine-readable identifier, so the UI can group or suppress by kind. */
  code?: string;
}

/** The assembled project view. */
export interface ProjectIndex {
  projectId: string;
  resources: ResourceDescriptor[];
  diagrams: DiagramDescriptor[];
  documents: DocumentDescriptor[];
  participants: ProjectSymbol[];
  /** Every place a participant name is written, declarations excluded. */
  usages: ProjectSymbolUsage[];
  references: ProjectReference[];
  diagnostics: ProjectDiagnostic[];
}

/** The index before validation has run (validation consumes the rest of it). */
export type ProjectIndexCore = Omit<ProjectIndex, "diagnostics">;

/** A reference as found in one file, before the project resolves it. */
export interface ReferenceCandidate {
  kind: ReferenceKind;
  target: string;
  sourceRange?: SourceRange;
}

/**
 * Everything the index knows about one resource, computed from that resource
 * alone. This is the unit the incremental indexer caches.
 */
export interface ResourceAnalysis {
  /** A fingerprint of the content this was computed from. */
  fingerprint: string;
  descriptor: ResourceDescriptor;
  /**
   * The title the resource declares for itself (a diagram `title` line, a
   * document's first heading), or `undefined` when it declares none.
   *
   * Kept apart from {@link ResourceDescriptor.title} — which falls back to the
   * path — so a rename can be folded into a cached analysis without re-parsing
   * the file: only the fallback changes.
   */
  declaredTitle?: string;
  symbols: ProjectSymbol[];
  usages: ProjectSymbolUsage[];
  references: ReferenceCandidate[];
  /** Problems found inside this resource without looking at any other file. */
  diagnostics: ProjectDiagnostic[];
  headings: MarkdownHeading[];
  metrics: { participants: number; messages: number; words: number };
}

/** How a reference resolved. */
export type ReferenceResolution =
  | { ok: true; resource: ResourceDescriptor }
  | {
      ok: false;
      reason: "external" | "missing" | "wrong-kind";
      detail: string;
    };

/** The scheme prefixes a stable reference may carry. */
const SCHEMES: ReadonlyArray<{
  prefix: string;
  expects: ResourceType | null;
}> = [
  { prefix: "resource://", expects: null },
  { prefix: "diagram://", expects: "sequence-diagram" },
  { prefix: "doc://", expects: "markdown-document" },
];

/** The resource type an embed directive names, or `null` when unknown. */
export function embedResourceType(label: string): ResourceType | null {
  switch (label.toLowerCase()) {
    case "diagram":
    case "sequence":
      return "sequence-diagram";
    case "doc":
    case "document":
    case "markdown":
      return "markdown-document";
    default:
      return null;
  }
}

/** Drop a `#fragment` or `?query` from a reference target. */
function bareTarget(target: string): string {
  return target.trim().split("#")[0].split("?")[0];
}

/** Decode a percent-encoded path, leaving malformed input untouched. */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Resolve one reference written in `from` against the project.
 *
 * A scheme target is looked up by stable id, so it keeps working after a rename;
 * a bare path or wiki name is matched against the current tree, preferring a
 * resource in the same project. An external URL is reported as `external` rather
 * than as broken, so the validator never complains about a link to the web.
 */
export function resolveReference(
  candidate: ReferenceCandidate,
  from: ResourceDescriptor,
  resources: ResourceDescriptor[],
  metadata: ProjectMetadata,
): ReferenceResolution {
  const raw = candidate.target.trim();
  if (raw === "") {
    return { ok: false, reason: "missing", detail: "empty reference" };
  }

  for (const scheme of SCHEMES) {
    if (!raw.toLowerCase().startsWith(scheme.prefix)) continue;
    const id = decodePath(bareTarget(raw.slice(scheme.prefix.length)));
    const record = resourceRecordById(metadata, id);
    if (!record) {
      return {
        ok: false,
        reason: "missing",
        detail: `no resource with id "${id}"`,
      };
    }
    const resource = resources.find((entry) => entry.id === id);
    if (!resource) {
      return {
        ok: false,
        reason: "missing",
        detail: `resource "${id}" is recorded but has no file`,
      };
    }
    if (scheme.expects && resource.type !== scheme.expects) {
      return {
        ok: false,
        reason: "wrong-kind",
        detail: `"${id}" is a ${resource.type}, not a ${scheme.expects}`,
      };
    }
    return { ok: true, resource };
  }

  if (isExternalHref(raw)) {
    return { ok: false, reason: "external", detail: raw };
  }

  const target = decodePath(bareTarget(raw));

  // An embed names the resource it renders, and the canonical way to name a
  // resource is its stable id. Try that first so `{{diagram:checkout}}` and
  // `{{diagram:diagram-checkout}}` both work, then fall through to the path and
  // title tiers a plain link uses.
  if (candidate.kind === "embed") {
    const record = resourceRecordById(metadata, target);
    if (record) {
      const resource = resources.find((entry) => entry.id === record.id);
      if (resource) return { ok: true, resource };
      return {
        ok: false,
        reason: "missing",
        detail: `resource "${target}" is recorded but has no file`,
      };
    }
  }

  const wantedPath = normalizePath(`${directoryOf(from.path)}/${target}`);
  const byPath = resources.find(
    (resource) => normalizePath(resource.path) === wantedPath,
  );
  if (byPath) return { ok: true, resource: byPath };

  const wantedName = basenameOf(target).toLowerCase();
  const byName = resources.filter(
    (resource) =>
      basenameOf(resource.path).toLowerCase() === wantedName ||
      resource.path.toLowerCase() === target.toLowerCase(),
  );
  if (byName.length > 0) {
    return {
      ok: true,
      resource:
        byName.find((resource) => resource.projectId === from.projectId) ??
        byName[0],
    };
  }

  // A wiki-link names a document rather than a file, so its display title is
  // the last thing to try.
  if (candidate.kind === "wiki-link" || candidate.kind === "diagram-ref") {
    const byTitle = resources.filter(
      (resource) => resource.title.toLowerCase() === target.toLowerCase(),
    );
    if (byTitle.length > 0) return { ok: true, resource: byTitle[0] };
  }

  return {
    ok: false,
    reason: "missing",
    detail: `nothing in the project matches "${raw}"`,
  };
}

/** The reference kind a markdown reference maps onto. */
export function referenceKindOf(
  kind: MarkdownReferenceKind,
): ReferenceKind | null {
  switch (kind) {
    case "wiki":
      return "wiki-link";
    case "link":
      return "resource-link";
    case "embed":
      return "embed";
    default:
      // An image is fetched, never resolved as a project reference.
      return null;
  }
}

/** Assemble the project index from per-resource analyses. */
export function buildProjectIndex(
  projectId: string,
  analyses: ResourceAnalysis[],
  metadata: ProjectMetadata,
  validate: (core: ProjectIndexCore) => ProjectDiagnostic[],
): ProjectIndex {
  // Sorted by path so the index is deterministic regardless of the order the
  // store happened to list the files in.
  const ordered = [...analyses].sort((a, b) =>
    a.descriptor.path.localeCompare(b.descriptor.path),
  );

  const resources = ordered.map((analysis) => analysis.descriptor);
  const diagrams: DiagramDescriptor[] = ordered
    .filter((analysis) => analysis.descriptor.type === "sequence-diagram")
    .map((analysis) => ({
      ...analysis.descriptor,
      type: "sequence-diagram",
      participants: analysis.metrics.participants,
      messages: analysis.metrics.messages,
      titled: analysis.descriptor.title !== analysis.descriptor.path,
    }));
  const documents: DocumentDescriptor[] = ordered
    .filter((analysis) => analysis.descriptor.type === "markdown-document")
    .map((analysis) => ({
      ...analysis.descriptor,
      type: "markdown-document",
      headings: analysis.headings,
      words: analysis.metrics.words,
    }));

  const usages = ordered.flatMap((analysis) => analysis.usages);

  // A resource is itself a symbol, so quick-open and find-references can treat
  // "the payment diagram" and "the PaymentService participant" alike.
  const resourceSymbols: ProjectSymbol[] = resources.map((resource) => ({
    id: `${resource.type === "sequence-diagram" ? "diagram" : "document"}:${resource.id}`,
    name: resource.title,
    kind: resource.type === "sequence-diagram" ? "diagram" : "document",
    resourceId: resource.id,
  }));

  const declared = ordered.flatMap((analysis) => analysis.symbols);
  const references: ProjectReference[] = [];
  for (const analysis of ordered) {
    for (const candidate of analysis.references) {
      const resolution = resolveReference(
        candidate,
        analysis.descriptor,
        resources,
        metadata,
      );
      references.push({
        from: analysis.descriptor.id,
        to: resolution.ok ? resolution.resource.id : null,
        kind: candidate.kind,
        raw: candidate.target,
        sourceRange: candidate.sourceRange,
        ...(resolution.ok
          ? {}
          : {
              problem: { reason: resolution.reason, detail: resolution.detail },
            }),
      });
    }
  }

  const core: ProjectIndexCore = {
    projectId,
    resources,
    diagrams,
    documents,
    participants: [...resourceSymbols, ...declared],
    usages,
    references,
  };

  return { ...core, diagnostics: validate(core) };
}

/** Icons and labels for a symbol kind, kept beside the kind for one source of truth. */
export const SYMBOL_KIND_LABELS: Record<SymbolKind, string> = {
  participant: "participant",
  actor: "actor",
  service: "service",
  database: "database",
  queue: "queue",
  diagram: "diagram",
  document: "document",
};

/**
 * Whether a project has two resources sharing an id.
 *
 * Exposed so a caller that has metadata but no index (an import, a migration)
 * can run the same check the validator does.
 */
export function hasDuplicateResourceIds(metadata: ProjectMetadata): boolean {
  return duplicateResourceIds(metadata).length > 0;
}
