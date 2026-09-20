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

/**
 * What a resource *is*, in documentation terms.
 *
 * Deliberately separate from {@link ResourceKind}, which says which store a file
 * lives in. A future event flow is a new type over an existing (or new) store,
 * and existing links keep resolving either way.
 */
export type ResourceType = "sequence-diagram" | "markdown-document";

/** The resource type a stored file kind maps onto. */
export function resourceTypeOf(kind: ResourceKind): ResourceType {
  return kind === "note" ? "markdown-document" : "sequence-diagram";
}

/** The stored file kind a resource type maps back onto. */
export function resourceKindOf(type: ResourceType): ResourceKind {
  return type === "markdown-document" ? "note" : "diagram";
}

/** The id prefix a resource type uses, so an id names its kind at a glance. */
export function resourceIdPrefix(type: ResourceType): string {
  return type === "markdown-document" ? "doc" : "diagram";
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
