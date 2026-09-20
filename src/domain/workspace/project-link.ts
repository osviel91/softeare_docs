/**
 * Resolving project-relative links written in documentation.
 *
 * A markdown document may point at another project resource with an ordinary
 * link — `[Payment flow](../diagrams/payment.seq)` — rather than the `[[Name]]`
 * wiki-link form. Resolving one is a pure path problem: take the linking
 * document's directory, apply the href, and match the result against the
 * workspace's resources.
 *
 * Two storage models have to agree here. In a local folder a resource's id *is*
 * its path, so a relative link resolves exactly. In-browser projects have no
 * directories at all — ids are generated and names are flat — so resolution falls
 * back to the file name, which is the only thing such a project has. This module
 * is framework-free and storage-agnostic, so both cases live in one testable
 * place.
 */
import type { ProjectResource } from "./resource";

/** What {@link resolveProjectLink} needs to resolve one href. */
export interface ProjectLinkContext {
  /** The id (in a folder, the path) of the document the link is written in. */
  fromId: string;
  /** The project the linking document belongs to; preferred when names repeat. */
  projectId: string;
  /** Every resource the link may resolve to, across the workspace. */
  resources: ProjectResource[];
}

/**
 * Whether an href points outside the project (or at nothing resolvable).
 *
 * Empty hrefs, fragments, root-absolute paths and anything carrying a URL scheme
 * (`https:`, `mailto:`, `javascript:`, …) are all left to the browser.
 */
export function isExternalHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed === "") return true;
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

/**
 * Normalize a `/`-separated path, collapsing `.` and `..` segments.
 *
 * A `..` that would climb above the root is dropped rather than escaping it,
 * which keeps a link from resolving to something outside the workspace.
 */
export function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** The directory part of a `/`-separated path (empty when there is none). */
export function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** The final segment of a `/`-separated path. */
export function basenameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** Decode a percent-encoded path, leaving it untouched when it is malformed. */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Resolve an href written in one document to a project resource, or `null`.
 *
 * Resolution is two-tiered:
 *
 * 1. **By path** — the href is resolved against the linking document's directory
 *    and matched against resource ids. This is exact for a local folder, where a
 *    resource's id is its relative path.
 * 2. **By file name** — the final segment is matched against resource names,
 *    preferring a resource in the linking document's own project. This is what
 *    makes links work for in-browser projects, which are flat.
 */
export function resolveProjectLink(
  href: string,
  context: ProjectLinkContext,
): ProjectResource | null {
  if (isExternalHref(href)) return null;
  // A fragment or query on a project link selects within the document, not a
  // different resource, so drop it before matching.
  const target = decodePath(href.trim().split("#")[0].split("?")[0]);
  if (target.trim() === "") return null;

  const wantedPath = normalizePath(`${directoryOf(context.fromId)}/${target}`);
  const byPath = context.resources.find(
    (resource) => normalizePath(resource.id) === wantedPath,
  );
  if (byPath) return byPath;

  const wantedName = basenameOf(target).toLowerCase();
  if (wantedName === "") return null;
  const byName = context.resources.filter(
    (resource) =>
      resource.name.toLowerCase() === wantedName ||
      basenameOf(resource.id).toLowerCase() === wantedName,
  );
  if (byName.length === 0) return null;
  return (
    byName.find((resource) => resource.projectId === context.projectId) ??
    byName[0]
  );
}
