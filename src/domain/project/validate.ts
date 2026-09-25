/**
 * The project validation service.
 *
 * Validation is a pure function of the index, so it is deliberately free of
 * React and of storage: the browser UI calls it, an export job can call it, and
 * the MCP server this project is being prepared for will call the same function.
 * Nothing here re-reads a file or re-parses text — the index already carries the
 * per-file diagnostics and the resolved references.
 *
 * The split of severity is a judgement about what a reader can act on:
 *
 * - **error** — the documentation is wrong. A stable reference that names nothing
 *   is a promise the project did not keep, and two resources sharing an id make
 *   `resource://` ambiguous.
 * - **warning** — the documentation is suspicious. A wiki-link or relative path
 *   that resolves to nothing may be a link to something outside the project, and
 *   two resources with the same title make navigation ambiguous.
 * - **info** — worth knowing while writing.
 */
import {
  duplicateResourceIds,
  duplicateSemanticMessageIds,
  type ProjectMetadata,
} from "../workspace/metadata";
import type {
  ProjectDiagnostic,
  ProjectIndexCore,
  ProjectReference,
} from "./project-index";

/** Stable, machine-readable project diagnostic identifiers. */
export const ProjectDiagnosticCode = {
  /** Two resources claim the same stable id. */
  DuplicateResourceId: "project.duplicate-resource-id",
  /** Two resources show the same title, so navigation is ambiguous. */
  DuplicateTitle: "project.duplicate-title",
  /** A stable reference (`resource://`, `diagram://`, `doc://`) names nothing. */
  BrokenResourceReference: "project.broken-reference",
  /** A `{{diagram:…}}` embed names nothing, so nothing can be rendered. */
  BrokenEmbed: "project.broken-embed",
  /** A reference resolves, but to the wrong kind of resource. */
  WrongReferenceKind: "project.wrong-reference-kind",
  /** A wiki-link or relative link resolves to nothing. */
  UnresolvedLink: "project.unresolved-link",
  DuplicateSemanticMessageId: "project.duplicate-semantic-message-id",
  DanglingSemanticMessageRef: "project.dangling-semantic-message-ref",
  SemanticMessageKindMismatch: "project.semantic-message-kind-mismatch",
} as const;

/** Whether a reference was written with a stable scheme. */
function hasStableScheme(raw: string): boolean {
  return /^(resource|diagram|doc):\/\//i.test(raw.trim());
}

function semanticMessageDiagnostics(
  core: ProjectIndexCore,
  metadata: ProjectMetadata,
): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = duplicateSemanticMessageIds(metadata).map((id) => ({
    severity: "error",
    code: ProjectDiagnosticCode.DuplicateSemanticMessageId,
    resourceId: core.resources[0]?.id ?? id,
    message: `Semantic message id "${id}" is declared more than once`,
  }));
  const identities = new Map((metadata.semanticMessages ?? []).map((message) => [message.id, message]));
  for (const occurrence of core.semanticOccurrences ?? []) {
    if (!occurrence.messageRef) continue;
    const identity = identities.get(occurrence.messageRef);
    if (!identity) {
      diagnostics.push({ severity: "error", code: ProjectDiagnosticCode.DanglingSemanticMessageRef, resourceId: occurrence.resourceId, sourceRange: occurrence.range, message: `Semantic message ref "${occurrence.messageRef}" does not exist` });
    } else if (identity.kind !== occurrence.kind) {
      diagnostics.push({ severity: "error", code: ProjectDiagnosticCode.SemanticMessageKindMismatch, resourceId: occurrence.resourceId, sourceRange: occurrence.range, message: `Semantic message "${identity.name}" is ${identity.kind}, but this occurrence is ${occurrence.kind}` });
    }
  }
  for (const entity of core.eventFlowMessages ?? []) {
    if (!entity.messageRef) continue;
    const identity = identities.get(entity.messageRef);
    if (!identity) {
      diagnostics.push({ severity: "error", code: ProjectDiagnosticCode.DanglingSemanticMessageRef, resourceId: entity.resourceId, sourceRange: entity.sourceRange, message: `Semantic message ref "${entity.messageRef}" does not exist` });
    } else if (identity.kind !== entity.kind) {
      diagnostics.push({ severity: "error", code: ProjectDiagnosticCode.SemanticMessageKindMismatch, resourceId: entity.resourceId, sourceRange: entity.sourceRange, message: `Semantic message "${identity.name}" is ${identity.kind}, but this Event Flow entity is ${entity.kind}` });
    }
  }
  return diagnostics;
}

/** The diagnostic a single unresolved reference earns, or `null` for none. */
function referenceDiagnostic(
  reference: ProjectReference,
): ProjectDiagnostic | null {
  const problem = reference.problem;
  if (!problem) return null;
  // A link to the web, an anchor, or a root-absolute path is not ours to check.
  if (problem.reason === "external") return null;

  const base = {
    resourceId: reference.from,
    sourceRange: reference.sourceRange,
  };

  if (problem.reason === "wrong-kind") {
    return {
      ...base,
      severity: "error",
      code: ProjectDiagnosticCode.WrongReferenceKind,
      message: `Reference "${reference.raw}" points at the wrong kind of resource: ${problem.detail}`,
    };
  }

  const stable = hasStableScheme(reference.raw);
  if (reference.kind === "embed") {
    return {
      ...base,
      severity: "error",
      code: ProjectDiagnosticCode.BrokenEmbed,
      message: `Embedded diagram "${reference.raw}" does not exist`,
    };
  }
  if (stable) {
    return {
      ...base,
      severity: "error",
      code: ProjectDiagnosticCode.BrokenResourceReference,
      message: `Reference "${reference.raw}" does not resolve: ${problem.detail}`,
    };
  }
  return {
    ...base,
    severity: "warning",
    code: ProjectDiagnosticCode.UnresolvedLink,
    message: `Link "${reference.raw}" does not match any project resource`,
  };
}

/** Diagnostics for two resources that show the same title. */
function duplicateTitleDiagnostics(
  core: ProjectIndexCore,
): ProjectDiagnostic[] {
  const byTitle = new Map<string, string[]>();
  for (const resource of core.resources) {
    const key = resource.title.trim().toLowerCase();
    if (key === "") continue;
    const ids = byTitle.get(key) ?? [];
    ids.push(resource.id);
    byTitle.set(key, ids);
  }

  const diagnostics: ProjectDiagnostic[] = [];
  for (const [key, ids] of byTitle) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      const resource = core.resources.find((entry) => entry.id === id);
      diagnostics.push({
        severity: "warning",
        code: ProjectDiagnosticCode.DuplicateTitle,
        resourceId: id,
        message: `"${resource?.title ?? key}" is the title of ${ids.length} resources, so navigation by name is ambiguous`,
      });
    }
  }
  return diagnostics;
}

/** Diagnostics for ids that appear on more than one metadata record. */
function duplicateIdDiagnostics(
  core: ProjectIndexCore,
  metadata: ProjectMetadata,
): ProjectDiagnostic[] {
  const duplicates = duplicateResourceIds(metadata);
  return duplicates.flatMap((id) => {
    // Report against every resource that claims the id, so the problems panel
    // can navigate to each of the colliding files.
    const paths = metadata.resources
      .filter((resource) => resource.id === id)
      .map((resource) => resource.path);
    return core.resources
      .filter((resource) => resource.id === id)
      .map(() => ({
        severity: "error" as const,
        code: ProjectDiagnosticCode.DuplicateResourceId,
        resourceId: id,
        message: `Resource id "${id}" is used by ${paths.length} resources (${paths.join(", ")}); ids must be unique`,
      }))
      .concat(
        // A duplicate id whose files are gone still deserves a report.
        core.resources.some((resource) => resource.id === id)
          ? []
          : [
              {
                severity: "error" as const,
                code: ProjectDiagnosticCode.DuplicateResourceId,
                resourceId: id,
                message: `Resource id "${id}" is used by ${paths.length} resources (${paths.join(", ")}); ids must be unique`,
              },
            ],
      );
  });
}

/**
 * Validate a project, from its index.
 *
 * @param core - The index without diagnostics.
 * @param perResource - Diagnostics each resource's own analysis produced.
 * @param metadata - The identity record, for the id-uniqueness check.
 */
export function validateProject(
  core: ProjectIndexCore,
  perResource: ProjectDiagnostic[],
  metadata: ProjectMetadata,
): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [...perResource];

  diagnostics.push(...duplicateIdDiagnostics(core, metadata));
  diagnostics.push(...duplicateTitleDiagnostics(core));
  diagnostics.push(...semanticMessageDiagnostics(core, metadata));

  for (const reference of core.references) {
    const diagnostic = referenceDiagnostic(reference);
    if (diagnostic) diagnostics.push(diagnostic);
  }

  return diagnostics;
}

/** The diagnostics of one severity, in index order. */
export function diagnosticsOfSeverity(
  diagnostics: ProjectDiagnostic[],
  severity: ProjectDiagnostic["severity"],
): ProjectDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === severity);
}
