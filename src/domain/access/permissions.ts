/**
 * The capability vocabulary: what a caller may do, independent of how they
 * authenticated and independent of which transport carried the request.
 *
 * A use case names the permission it needs (`resource:write`); it never asks
 * "is this user an editor?". Roles and credentials both collapse into a set of
 * permissions *before* any use case runs, so neither a controller nor an MCP
 * tool can disagree about what a role means:
 *
 * ```
 * role (OWNER)            -> permissions   ─┐
 * PAT scopes              -> permissions   ─┼─► authorize(principal, permission, resource)
 * OAuth `docs.*` scopes   -> permissions   ─┘
 * ```
 *
 * Phase 3 adds `authorize()`; this module fixes the nouns so the persistence,
 * authentication and tool layers can all name the same thing from the start.
 */

/** One thing a caller can be allowed to do. */
export type Permission =
  | "project:read"
  | "project:write"
  | "project:admin"
  | "resource:read"
  | "resource:write"
  | "diagram:render"
  | "project:validate"
  | "project:export"
  | "mcp:read"
  | "mcp:write";

/** Every permission, in a stable order — useful for validation and UI lists. */
export const ALL_PERMISSIONS: readonly Permission[] = [
  "project:read",
  "project:write",
  "project:admin",
  "resource:read",
  "resource:write",
  "diagram:render",
  "project:validate",
  "project:export",
  "mcp:read",
  "mcp:write",
];

/**
 * A credential's granted permissions.
 *
 * The same type names a PAT's scopes and a principal's effective permissions.
 * OAuth scopes in the `docs.*` namespace are mapped onto these by a single
 * function in Phase 8, so nothing downstream needs to know which namespace a
 * grant arrived in.
 */
export type Scope = Permission;

/** A caller's relationship to one project. */
export type ProjectRole = "OWNER" | "EDITOR" | "VIEWER";

/** Every role, most privileged first. */
export const ALL_PROJECT_ROLES: readonly ProjectRole[] = [
  "OWNER",
  "EDITOR",
  "VIEWER",
];

/**
 * What each role may do.
 *
 * This table is the *only* place a role is interpreted. `project:admin` is
 * deliberately absent from EDITOR and VIEWER, and destructive project actions
 * require it, which is the boundary the mission's agent-safety section asks for.
 */
export const PERMISSIONS_BY_ROLE: Readonly<
  Record<ProjectRole, readonly Permission[]>
> = {
  OWNER: [
    "project:read",
    "project:write",
    "project:admin",
    "resource:read",
    "resource:write",
    "diagram:render",
    "project:validate",
    "project:export",
    "mcp:read",
    "mcp:write",
  ],
  EDITOR: [
    "project:read",
    "project:write",
    "resource:read",
    "resource:write",
    "diagram:render",
    "project:validate",
    "project:export",
    "mcp:read",
    "mcp:write",
  ],
  VIEWER: [
    "project:read",
    "resource:read",
    "diagram:render",
    "project:validate",
    "project:export",
    "mcp:read",
  ],
};

/**
 * Named authorization profiles for non-human callers.
 *
 * A profile is a *starting point* for a token's scopes, not a special case in
 * the use cases: an agent with `READ_ONLY_AGENT` is simply a principal whose
 * scopes do not include `resource:write`. Keeping the profiles here means the
 * Settings UI, the token endpoint and the tests all offer the same three.
 */
export const AGENT_PROFILES: Readonly<Record<string, readonly Permission[]>> = {
  READ_ONLY_AGENT: [
    "project:read",
    "resource:read",
    "project:validate",
    "diagram:render",
    "mcp:read",
  ],
  DOCUMENTATION_AGENT: [
    "project:read",
    "resource:read",
    "resource:write",
    "project:validate",
    "diagram:render",
    "mcp:read",
    "mcp:write",
  ],
  PROJECT_ADMIN: ALL_PERMISSIONS,
};

/** Whether a value is one of the known permissions. */
export function isPermission(value: unknown): value is Permission {
  return (
    typeof value === "string" &&
    (ALL_PERMISSIONS as readonly string[]).includes(value)
  );
}

/** Whether a value is one of the known project roles. */
export function isProjectRole(value: unknown): value is ProjectRole {
  return (
    typeof value === "string" &&
    (ALL_PROJECT_ROLES as readonly string[]).includes(value)
  );
}

/** The permissions a role carries, as a fresh array. */
export function permissionsOfRole(role: ProjectRole): Permission[] {
  return [...PERMISSIONS_BY_ROLE[role]];
}

/**
 * Map an OAuth scope string onto an application permission.
 *
 * Phase 7/8 defines the `docs.*` scope namespace an external authorization
 * server issues; this is the single translation point, so an OAuth access token
 * and a PAT reach the authorization policy as the same kind of grant.
 */
export const OAUTH_SCOPE_TO_PERMISSION: Readonly<Record<string, Permission>> = {
  "docs.projects.read": "project:read",
  "docs.projects.write": "project:write",
  "docs.projects.admin": "project:admin",
  "docs.projects.validate": "project:validate",
  "docs.resources.read": "resource:read",
  "docs.resources.write": "resource:write",
  "docs.diagrams.render": "diagram:render",
};

/** Translate OAuth scope strings into permissions, dropping unknown ones. */
export function permissionsOfOAuthScopes(
  scopes: readonly string[],
): Permission[] {
  const mapped: Permission[] = [];
  for (const scope of scopes) {
    const permission = OAUTH_SCOPE_TO_PERMISSION[scope];
    if (permission !== undefined && !mapped.includes(permission)) {
      mapped.push(permission);
    }
  }
  return mapped;
}
