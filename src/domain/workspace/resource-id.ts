/**
 * Stable resource identity.
 *
 * A resource's *path* is where its file happens to live; a resource's *id* is
 * what documentation refers to. Keeping them apart is what lets
 * `resource://diagram-payment-processing` survive renaming the file to
 * `payment-processing.seq` or moving it between projects.
 *
 * The two are stored side by side in a project's metadata (see `metadata.ts`):
 * the file stays the source of truth for content, the metadata is the record
 * that a given file has a given id. Nothing here touches persistence — id
 * generation is a pure naming problem, so it is testable on its own and a
 * migration can be reasoned about without a repository.
 */
import type { ResourceKind } from "./resource";

/** A stable identifier for a project resource. */
export type ResourceId = string;

/** How a resource's content is interpreted. */
export type ResourceRepresentation = "sequence" | "event-flow" | "markdown";

/** Persisted/API spelling retained for compatibility. */
export type ResourceType =
  | "sequence-diagram"
  | "event-flow"
  | "markdown-document";

/** The two independent facts derived from a resource type. */
export interface ResourceClassification {
  kind: ResourceKind;
  representation: ResourceRepresentation;
}

/** Resolve the explicit domain representation from persisted/API terminology. */
export function resourceRepresentationOfType(
  type: ResourceType,
): ResourceRepresentation {
  switch (type) {
    case "event-flow":
      return "event-flow";
    case "markdown-document":
      return "markdown";
    default:
      return "sequence";
  }
}

/** Map a domain representation back to the persisted/API spelling. */
export function resourceTypeOfRepresentation(
  representation: ResourceRepresentation,
): ResourceType {
  switch (representation) {
    case "event-flow":
      return "event-flow";
    case "markdown":
      return "markdown-document";
    default:
      return "sequence-diagram";
  }
}

/** Resolve both resource dimensions from existing persisted information. */
export function resourceClassificationOf(
  type: ResourceType,
): ResourceClassification {
  const representation = resourceRepresentationOfType(type);
  return {
    representation,
    kind: representation === "markdown" ? "note" : "diagram",
  };
}

/** Classify a descriptor while accepting legacy callers that only provide type. */
export function resourceClassificationOfDescriptor(
  descriptor: { type: ResourceType } & Partial<ResourceClassification>,
): ResourceClassification {
  if (descriptor.kind && descriptor.representation) {
    return { kind: descriptor.kind, representation: descriptor.representation };
  }
  return resourceClassificationOf(descriptor.type);
}

/**
 * The resource type a stored file kind maps onto.
 *
 * A store kind alone cannot tell a sequence diagram from an event flow — both
 * live in the diagram store — so this is the coarse answer, and
 * {@link resourceTypeOfName} is the accurate one wherever the file name is
 * known. Both exist because the repositories list files by store, while the
 * index, the outline and the editor need the language.
 */
export function resourceTypeOf(kind: ResourceKind): ResourceType {
  return kind === "note" ? "markdown-document" : "sequence-diagram";
}

/** Resolve the representation implied by a file name. */
export function resourceRepresentationOfName(
  name: string,
): ResourceRepresentation {
  if (/\.md$/i.test(name)) return "markdown";
  if (/\.eventseq$/i.test(name)) return "event-flow";
  return "sequence";
}

/**
 * The resource type a file name implies.
 *
 * The extension is the discriminator, exactly as it is for a folder project:
 * `.md` is a document, `.eventseq` an event flow, anything else a sequence
 * diagram. That keeps the rule in one place instead of scattering extension
 * checks through the UI.
 */
export function resourceTypeOfName(name: string): ResourceType {
  return resourceTypeOfRepresentation(resourceRepresentationOfName(name));
}

/** The stored file kind a resource type maps back onto. */
export function resourceKindOf(type: ResourceType): ResourceKind {
  return type === "markdown-document" ? "note" : "diagram";
}

/** The id prefix a resource type uses, so an id names its kind at a glance. */
export function resourceIdPrefix(type: ResourceType): string {
  switch (type) {
    case "markdown-document":
      return "doc";
    case "event-flow":
      return "flow";
    default:
      return "diagram";
  }
}

/**
 * Turn arbitrary text into a lowercase, `-`-separated id fragment.
 *
 * Accents are stripped rather than dropped so `Configuración` becomes
 * `configuracion` instead of `configuraci-n`; anything left that is not a letter
 * or digit becomes a separator.
 */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The first-choice id for a resource: its type's prefix plus the slug of its
 * name.
 *
 * A file called `Payment Processing.seq` yields `diagram-payment-processing`;
 * a name with nothing sluggable falls back to the bare prefix, which
 * {@link uniqueResourceId} then disambiguates.
 */
export function defaultResourceId(type: ResourceType, name: string): string {
  const base = name.replace(/\.[^./\\]+$/, "");
  const slug = slugify(base);
  return slug === ""
    ? resourceIdPrefix(type)
    : `${resourceIdPrefix(type)}-${slug}`;
}

/**
 * Pick an id that is free among `taken`: the candidate itself, else `-2`, `-3`, …
 *
 * Only a collision needs a suffix, so a project whose names are already distinct
 * gets the readable `<prefix>-<slug>` form throughout.
 */
export function uniqueResourceId(
  candidate: string,
  taken: Iterable<string>,
): string {
  const used = taken instanceof Set ? taken : new Set(taken);
  if (!used.has(candidate)) return candidate;
  let index = 2;
  while (used.has(`${candidate}-${index}`)) index += 1;
  return `${candidate}-${index}`;
}

/** Whether a string looks like a resource id (used when parsing links). */
export function isResourceId(value: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(value);
}
