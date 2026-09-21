/**
 * The server project model (ADR-040).
 *
 * A **server project** is the server-side counterpart of a local workspace
 * project. It has an owner, a membership list, and resources persisted on the
 * server, and it is what the HTTP API and the remote MCP server operate on.
 *
 * Legacy `WorkspaceRepository`. The two models coexist on purpose: local mode
 * stays local-first, and only a project the user explicitly creates on the
 * server is server-managed.
 *
 * The relational tables here hold *identity and authority* — who owns a project,
 * who may read it, which resources exist and at what revision. The document
 * content itself stays in `.seq`, `.eventseq` and `.md` files inside the
 * project's storage directory, so a server project is as portable as a local
 * one and no diagram semantics leak into SQL.
 */
import type { ProjectRole } from "../access/permissions";

/** A server-managed project. */
export interface ServerProject {
  /** UUIDv7 primary key. The authoritative identifier at every edge. */
  id: string;
  /** The user who created it, and the only implicit OWNER. */
  ownerId: string;
  /** Display name. Not unique — two projects may share a name. */
  name: string;
  /**
   * URL-safe unique handle derived from the name.
   *
   * It is a convenience for humans, not an authority boundary: every API route
   * addresses a project by id, and a slug lookup still authorizes by
   * membership.
   */
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One user's role in one project. */
export interface ProjectMember {
  projectId: string;
  userId: string;
  role: ProjectRole;
  createdAt: Date;
}

/** A project together with the requesting user's role in it. */
export interface ProjectAccess {
  project: ServerProject;
  role: ProjectRole;
}

/** A project plus the counts a listing shows, without reading its files. */
export interface ProjectListing extends ProjectAccess {
  /** How many resources are recorded for the project. */
  resourceCount: number;
}

/** Fields a project create or update accepts. */
export interface ProjectDraft {
  name: string;
  slug: string;
}

/**
 * Turn a display name into a slug.
 *
 * Deliberately conservative: lower-case ASCII words joined by single hyphens. A
 * name with no ASCII word left (for example one written entirely in a
 * non-Latin script) yields an empty slug, and the caller falls back to the
 * generated project id — a slug is a convenience, and an empty one is worse
 * than a boring one.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/** Whether a slug is well-formed. */
export function isSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
