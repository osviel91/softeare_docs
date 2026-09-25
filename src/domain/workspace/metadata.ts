/**
 * Project metadata: the persisted record of which stable id belongs to which
 * file.
 *
 * Files remain the source of truth for content; this sidecar is the source of
 * truth for *identity*. It is deliberately tiny, ordered, and human-readable so
 * it diffs cleanly in Git and an agent can read it without running the app:
 *
 * ```json
 * {
 *   "format": "sequencediagrams-project",
 *   "version": 1,
 *   "resources": [
 *     { "id": "diagram-payment-processing", "path": "payment-processing.seq",
 *       "type": "sequence-diagram", "title": "Payment Processing" }
 *   ]
 * }
 * ```
 *
 * Three operations live here, all pure, so the migration story is testable
 * without a repository:
 *
 * - {@link reconcileMetadata} — make the records match the files that actually
 *   exist, minting ids for files that have none and dropping records for files
 *   that are gone. This is the migration path for projects created before ids
 *   existed.
 * - {@link renameResourcePath} — move a record to a new path, keeping its id.
 * - {@link duplicateResourceIds} — the uniqueness check the validator reports.
 */
import {
  defaultResourceId,
  uniqueResourceId,
  type ResourceId,
  type ResourceType,
} from "./resource-id";
import {
  normalizeResourceMetadata,
  parseResourceMetadata,
  type ResourceMetadata,
} from "./resource-metadata";
import type { ResourceRelationship } from "./resource-relationship";
import {
  normalizeResourceRelationship,
  sameResourceRelationship,
} from "./resource-relationship";

/** The `format` marker written into a project metadata file. */
export const PROJECT_METADATA_FORMAT = "sequencediagrams-project";
/** The metadata schema version this module reads and writes. */
export const PROJECT_METADATA_VERSION = 1;
/**
 * The metadata file's name inside a project directory.
 *
 * A folder project stores this beside its documents, so the identity record
 * travels with the project and a filesystem repository must exclude it from the
 * files it lists as resources.
 */
export const PROJECT_METADATA_FILE_NAME = "project.json";

/** One resource's identity record. */
export interface ResourceRecord {
  /** The stable id documentation refers to. */
  id: ResourceId;
  /** Where the resource currently lives, relative to the project. */
  path: string;
  /** What the resource is. */
  type: ResourceType;
  /** The last known display title, for browsable metadata and rename reports. */
  title?: string;
  /** Free-form labels for filtering, carried through untouched. */
  tags?: string[];
  /** Semantic metadata for the resource, absent in legacy manifests. */
  metadata?: ResourceMetadata;
}

/** A project-scoped architectural message identity. Names are display data, not identity. */
export interface SemanticMessageIdentity {
  id: string;
  name: string;
  kind: "event" | "command";
}

/** A project's persisted identity record. */
export interface ProjectMetadata {
  format: string;
  version: number;
  resources: ResourceRecord[];
  relationships?: ResourceRelationship[];
  semanticMessages?: SemanticMessageIdentity[];
}

/** A file the metadata should describe, as the repository reports it. */
export interface MetadataFile {
  path: string;
  type: ResourceType;
  title?: string;
}

/** The outcome of reconciling stored metadata with the files on disk. */
export interface ReconcileResult {
  /** The metadata to persist. */
  metadata: ProjectMetadata;
  /** Whether it differs from what was passed in (so a write is worthwhile). */
  changed: boolean;
  /** Ids assigned during this reconciliation, for reporting a migration. */
  assigned: Array<{ id: ResourceId; path: string }>;
  /** Paths whose records were dropped because the file is gone. */
  removed: string[];
}

/** An empty, well-formed metadata document. */
export function createEmptyMetadata(): ProjectMetadata {
  return {
    format: PROJECT_METADATA_FORMAT,
    version: PROJECT_METADATA_VERSION,
    resources: [],
    relationships: [],
    semanticMessages: [],
  };
}

/** Whether a value is one of the resource types this app understands. */
function isResourceType(value: unknown): value is ResourceType {
  return (
    value === "sequence-diagram" ||
    value === "event-flow" ||
    value === "markdown-document"
  );
}

/**
 * Read a metadata document from untrusted JSON, or `null` when it is not ours.
 *
 * A file that is absent, malformed, or written by a future version is treated as
 * "no metadata" rather than as an error: the caller then reconciles from the
 * files and writes a fresh document, which is exactly the migration behaviour we
 * want for a project that predates ids.
 */
export function parseProjectMetadata(value: unknown): ProjectMetadata | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.format !== PROJECT_METADATA_FORMAT) return null;
  if (record.version !== PROJECT_METADATA_VERSION) return null;
  if (!Array.isArray(record.resources)) return null;

  const resources: ResourceRecord[] = [];
  for (const entry of record.resources) {
    if (typeof entry !== "object" || entry === null) return null;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id === "") return null;
    if (typeof item.path !== "string" || item.path === "") return null;
    if (!isResourceType(item.type)) return null;
    const resource: ResourceRecord = {
      id: item.id,
      path: item.path,
      type: item.type,
    };
    if (typeof item.title === "string") resource.title = item.title;
    if (Array.isArray(item.tags)) {
      resource.tags = item.tags.filter(
        (tag): tag is string => typeof tag === "string",
      );
    }
    const semanticMetadata = parseResourceMetadata(item.metadata);
    if (semanticMetadata) resource.metadata = semanticMetadata;
    resources.push(resource);
  }
  return {
    format: PROJECT_METADATA_FORMAT,
    version: PROJECT_METADATA_VERSION,
    resources,
    ...(Array.isArray(record.relationships)
      ? { relationships: record.relationships.filter((item): item is ResourceRelationship => {
          if (typeof item !== "object" || item === null) return false;
          const relation = item as Record<string, unknown>;
          return (
            relation.kind === "complementary-view" &&
            typeof relation.sourceId === "string" &&
            typeof relation.targetId === "string"
          );
        }) }
      : {}),
    ...(Array.isArray(record.semanticMessages)
      ? { semanticMessages: record.semanticMessages.filter((item): item is SemanticMessageIdentity => {
          if (typeof item !== "object" || item === null) return false;
          const message = item as Record<string, unknown>;
          return typeof message.id === "string" && message.id !== "" &&
            typeof message.name === "string" && message.name !== "" &&
            (message.kind === "event" || message.kind === "command");
        }) }
      : {}),
  };
}

export function semanticMessageById(
  metadata: ProjectMetadata,
  id: string,
): SemanticMessageIdentity | null {
  return metadata.semanticMessages?.find((message) => message.id === id) ?? null;
}

export function duplicateSemanticMessageIds(metadata: ProjectMetadata): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const message of metadata.semanticMessages ?? []) {
    if (seen.has(message.id) && !duplicates.includes(message.id)) duplicates.push(message.id);
    seen.add(message.id);
  }
  return duplicates;
}

export function upsertSemanticMessage(
  metadata: ProjectMetadata,
  message: SemanticMessageIdentity,
): ProjectMetadata {
  const messages = metadata.semanticMessages ?? [];
  const existing = messages.findIndex((entry) => entry.id === message.id);
  if (existing < 0) return { ...metadata, semanticMessages: [...messages, message] };
  const next = [...messages];
  next[existing] = message;
  return { ...metadata, semanticMessages: next };
}

export function removeSemanticMessage(
  metadata: ProjectMetadata,
  id: string,
): ProjectMetadata {
  return {
    ...metadata,
    semanticMessages: (metadata.semanticMessages ?? []).filter((message) => message.id !== id),
  };
}

/** Serialize metadata as the human-readable JSON written to disk. */
export function serializeProjectMetadata(metadata: ProjectMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

/** Ids that appear on more than one record, in first-seen order. */
export function duplicateResourceIds(metadata: ProjectMetadata): ResourceId[] {
  const seen = new Set<ResourceId>();
  const duplicates: ResourceId[] = [];
  for (const resource of metadata.resources) {
    if (seen.has(resource.id)) {
      if (!duplicates.includes(resource.id)) duplicates.push(resource.id);
    } else {
      seen.add(resource.id);
    }
  }
  return duplicates;
}

/** Ids that appear on more than one record, for the uniqueness check. */
export function resourceIds(metadata: ProjectMetadata): ResourceId[] {
  return metadata.resources.map((resource) => resource.id);
}

/** Whether two records describe the same thing, so a write can be skipped. */
function sameRecords(a: ResourceRecord[], b: ResourceRecord[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((record, index) => {
    const other = b[index];
    return (
      record.id === other.id &&
      record.path === other.path &&
      record.type === other.type &&
      record.title === other.title &&
      (record.tags ?? []).join("\u0000") === (other.tags ?? []).join("\u0000") &&
      JSON.stringify(record.metadata ?? {}) === JSON.stringify(other.metadata ?? {})
    );
  });
}

function sameSemanticMessages(
  a: SemanticMessageIdentity[] | undefined,
  b: SemanticMessageIdentity[] | undefined,
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * Reconcile stored metadata with the files that exist.
 *
 * Records are kept in the incoming order so ids stay stable and the document
 * does not churn in Git; a file that has no record gets a deterministic id from
 * its name (see `resource-id.ts`), disambiguated against every id already in
 * use. A record whose file has disappeared is dropped — but only after the
 * caller has had the chance to record a rename, which {@link renameResourcePath}
 * does by updating the path first.
 *
 * A file keeps its record across a *content* change; only the path matters here,
 * and a title change updates the stored title in place.
 */
export function reconcileMetadata(
  stored: ProjectMetadata | null,
  files: MetadataFile[],
): ReconcileResult {
  const previous = stored ?? createEmptyMetadata();
  const byPath = new Map(previous.resources.map((r) => [r.path, r]));
  const used = new Set<ResourceId>();
  const resources: ResourceRecord[] = [];
  const assigned: ReconcileResult["assigned"] = [];

  for (const file of files) {
    const existing = byPath.get(file.path);
    if (existing && !used.has(existing.id)) {
      used.add(existing.id);
      const next: ResourceRecord = {
        id: existing.id,
        path: file.path,
        type: file.type,
      };
      const title = file.title ?? existing.title;
      if (title !== undefined) next.title = title;
       if (existing.tags) next.tags = existing.tags;
       if (existing.metadata) next.metadata = normalizeResourceMetadata(existing.metadata);
      resources.push(next);
      continue;
    }

    // A brand new file (or one whose stored record duplicates another id, which
    // only a hand-edited document can produce): mint a fresh id for it.
    const id = uniqueResourceId(defaultResourceId(file.type, file.path), used);
    used.add(id);
    assigned.push({ id, path: file.path });
    const record: ResourceRecord = { id, path: file.path, type: file.type };
    if (file.title !== undefined) record.title = file.title;
    resources.push(record);
  }

  const keptPaths = new Set(resources.map((resource) => resource.path));
  const removed = previous.resources
    .map((resource) => resource.path)
    .filter((path) => !keptPaths.has(path));

  const metadata: ProjectMetadata = {
    format: PROJECT_METADATA_FORMAT,
    version: PROJECT_METADATA_VERSION,
    resources,
    ...(previous.relationships === undefined
      ? {}
      : {
          relationships: previous.relationships.filter(
            (relationship) =>
              resources.some((resource) => resource.id === relationship.sourceId) &&
              resources.some((resource) => resource.id === relationship.targetId),
          ),
        }),
    ...(previous.semanticMessages === undefined
      ? {}
      : { semanticMessages: previous.semanticMessages }),
  };
  return {
    metadata,
    changed:
      !sameRecords(previous.resources, resources) ||
      !sameSemanticMessages(previous.semanticMessages, metadata.semanticMessages),
    assigned,
    removed,
  };
}

/**
 * Move a record to a new path, preserving its id.
 *
 * This is the whole point of the metadata: a rename changes where the file
 * lives, never what documentation calls it, so every `resource://` link keeps
 * resolving. A path that is not recorded changes nothing.
 */
export function renameResourcePath(
  metadata: ProjectMetadata,
  fromPath: string,
  toPath: string,
): ProjectMetadata {
  if (!metadata.resources.some((resource) => resource.path === fromPath)) {
    return metadata;
  }
  return {
    ...metadata,
    resources: metadata.resources.map((resource) =>
      resource.path === fromPath ? { ...resource, path: toPath } : resource,
    ),
  };
}

/**
 * Update a record's stored title, if the path is known.
 *
 * Returns the same document when nothing matched, so a caller can use identity
 * to decide whether a write is worth doing.
 */
export function setResourceTitle(
  metadata: ProjectMetadata,
  path: string,
  title: string,
): ProjectMetadata {
  if (!metadata.resources.some((resource) => resource.path === path)) {
    return metadata;
  }
  return {
    ...metadata,
    resources: metadata.resources.map((resource) =>
      resource.path === path ? { ...resource, title } : resource,
    ),
  };
}

/** The record for a path, or `null` when the path is not recorded. */
export function resourceRecordAt(
  metadata: ProjectMetadata,
  path: string,
): ResourceRecord | null {
  return metadata.resources.find((resource) => resource.path === path) ?? null;
}

/** The record for an id, or `null` when the id is not recorded. */
export function resourceRecordById(
  metadata: ProjectMetadata,
  id: ResourceId,
): ResourceRecord | null {
  return metadata.resources.find((resource) => resource.id === id) ?? null;
}

/** The path an id currently resolves to, or `null` when the id is unknown. */
export function pathForResourceId(
  metadata: ProjectMetadata,
  id: ResourceId,
): string | null {
  return resourceRecordById(metadata, id)?.path ?? null;
}

export function addResourceRelationship(
  metadata: ProjectMetadata,
  relationship: ResourceRelationship,
): ProjectMetadata {
  const next = normalizeResourceRelationship(relationship);
  if ((metadata.relationships ?? []).some((item) => sameResourceRelationship(item, next))) {
    return metadata;
  }
  return { ...metadata, relationships: [...(metadata.relationships ?? []), next] };
}

export function removeResourceRelationships(
  metadata: ProjectMetadata,
  resourceId: string,
): ProjectMetadata {
  const relationships = (metadata.relationships ?? []).filter(
    (item) => item.sourceId !== resourceId && item.targetId !== resourceId,
  );
  return { ...metadata, relationships };
}
