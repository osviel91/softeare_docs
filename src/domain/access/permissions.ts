/**
 * The capability vocabulary: what a caller may do, independent of how they
 * authenticated and independent of which transport carried the request.
 *
 * A use case names the permission it needs (`resource:update`); it never asks
 * "is this user an editor?". Roles and credentials both collapse into a set of
 * permissions *before* any use case runs, so neither a controller nor an MCP
 * tool can disagree about what a role means:
 *
 * ```
 * role (OWNER)               -> permissions   ─┐
 * credential scopes          -> permissions   ─┼─► authorize(role, permission)
 * OAuth `docs.*` scopes      -> permissions   ─┘
 * ```
 *
 * ## Two vocabularies, deliberately
 *
 * {@link Permission} is the fine-grained capability a *use case* requires. It is
 * the only thing authorization ever compares.
 *
 * {@link CredentialScope} is what a *credential* is granted. It is the same
 * names plus one ergonomic shorthand, {@link RESOURCE_WRITE_SCOPE}
 * (`resource:write`), which expands into create/update/move/delete. A user
 * configuring an agent should be able to say "may write documents" without
 * ticking four boxes, but no use case ever asks for `resource:write`.
 *
 * ## Administrative capabilities
 *
 * {@link ADMIN_PERMISSIONS} — deleting a project, changing membership, managing
 * agents, credentials or users — are capabilities a normal agent credential is
 * never granted by default. The default profile is read-oriented (see
 * {@link DEFAULT_CREDENTIAL_SCOPES}); a user has to enable more on purpose.
 */

/** One thing a caller can be allowed to do. */
export type Permission =
  | "project:read"
  | "project:create"
  | "project:update"
  | "project:delete"
  | "project:members:write"
  | "resource:read"
  | "resource:create"
  | "resource:update"
  | "resource:move"
  | "resource:delete"
  | "diagram:render"
  | "project:search"
  | "project:validate"
  | "project:export"
  | "agent:manage"
  | "credential:manage"
  | "user:manage";

/** Every permission, in a stable order — useful for validation and UI lists. */
export const ALL_PERMISSIONS: readonly Permission[] = [
  "project:read",
  "project:create",
  "project:update",
  "project:delete",
  "project:members:write",
  "resource:read",
  "resource:create",
  "resource:update",
  "resource:move",
  "resource:delete",
  "diagram:render",
  "project:search",
  "project:validate",
  "project:export",
  "agent:manage",
  "credential:manage",
  "user:manage",
];

/**
 * A credential's granted permissions.
 *
 * The same type names a credential's effective capabilities and a principal's
 * `scopes` field.
 */
export type Scope = Permission;

/**
 * The capabilities a normal agent credential is never granted by default.
 *
 * Some are project-scoped (`project:delete`, `project:members:write`); the rest
 * are account-scoped and exist so a future OAuth client can be granted them
 * explicitly. None appear in {@link DEFAULT_CREDENTIAL_SCOPES}, and the
 * credential screen does not offer them.
 */
export const ADMIN_PERMISSIONS: readonly Permission[] = [
  "project:delete",
  "project:members:write",
  "agent:manage",
  "credential:manage",
  "user:manage",
];

/** A caller's relationship to one project. */
export type ProjectRole = "OWNER" | "EDITOR" | "VIEWER";

/** Every role, most privileged first. */
export const ALL_PROJECT_ROLES: readonly ProjectRole[] = [
  "OWNER",
  "EDITOR",
  "VIEWER",
];

/** The capabilities a role that may change documents carries. */
const RESOURCE_WRITE_PERMISSIONS: readonly Permission[] = [
  "resource:create",
  "resource:update",
  "resource:move",
  "resource:delete",
];

/** What every role can do in a project it can see. */
const READ_PERMISSIONS: readonly Permission[] = [
  "project:read",
  "resource:read",
  "diagram:render",
  "project:search",
  "project:validate",
  "project:export",
];

/**
 * What each role may do.
 *
 * This table is the *only* place a role is interpreted. Administrative
 * capabilities are absent from EDITOR and VIEWER on purpose: they are the
 * boundary the mission's agent-safety section asks for.
 */
export const PERMISSIONS_BY_ROLE: Readonly<
  Record<ProjectRole, readonly Permission[]>
> = {
  OWNER: [
    ...READ_PERMISSIONS,
    "project:create",
    "project:update",
    "project:delete",
    "project:members:write",
    ...RESOURCE_WRITE_PERMISSIONS,
    "agent:manage",
    "credential:manage",
    "user:manage",
  ],
  EDITOR: [...READ_PERMISSIONS, ...RESOURCE_WRITE_PERMISSIONS],
  VIEWER: [...READ_PERMISSIONS],
};

/**
 * The shorthand scope a credential can be granted instead of the four
 * resource-write permissions individually.
 */
export const RESOURCE_WRITE_SCOPE = "resource:write";

/**
 * The scope a credential may carry: a permission, or the write shorthand.
 *
 * This is the persisted form of a credential's grant. It is expanded to
 * {@link Permission}s by {@link permissionsOfCredentialScopes} before any use
 * case sees it, so `resource:write` never reaches authorization.
 */
export type CredentialScope = Permission | typeof RESOURCE_WRITE_SCOPE;

/** Every credential scope, in a stable order. */
export const CREDENTIAL_SCOPES: readonly CredentialScope[] = [
  ...ALL_PERMISSIONS,
  RESOURCE_WRITE_SCOPE,
];

/** Each fine-grained permission expands to itself. */
const PERMISSIONS_BY_PERMISSION = Object.fromEntries(
  ALL_PERMISSIONS.map((permission) => [permission, [permission]]),
) as unknown as Record<Permission, readonly Permission[]>;

/**
 * The permissions one credential scope expands to.
 *
 * This is the only place the shorthand is interpreted: a caller never has to
 * remember that `resource:write` means four things.
 */
export const PERMISSIONS_BY_CREDENTIAL_SCOPE: Readonly<
  Record<CredentialScope, readonly Permission[]>
> = {
  ...PERMISSIONS_BY_PERMISSION,
  [RESOURCE_WRITE_SCOPE]: RESOURCE_WRITE_PERMISSIONS,
};

/**
 * The conservative profile a new credential starts from.
 *
 * Mirrors the mission's default security profile: read a project, read and
 * render its documents, search and validate. Nothing here can change or delete
 * anything, so a user has to enable write access on purpose.
 */
export const DEFAULT_CREDENTIAL_SCOPES: readonly CredentialScope[] = [
  "project:read",
  "resource:read",
  "diagram:render",
  "project:search",
  "project:validate",
];

/** Named credential profiles a UI can offer as starting points. */
export const CREDENTIAL_PROFILES: Readonly<
  Record<string, readonly CredentialScope[]>
> = {
  READ_ONLY: DEFAULT_CREDENTIAL_SCOPES,
  DOCUMENTATION: [...DEFAULT_CREDENTIAL_SCOPES, RESOURCE_WRITE_SCOPE],
};

/** Whether a value is one of the known permissions. */
export function isPermission(value: unknown): value is Permission {
  return (
    typeof value === "string" &&
    (ALL_PERMISSIONS as readonly string[]).includes(value)
  );
}

/** Whether a value is one of the known credential scopes. */
export function isCredentialScope(value: unknown): value is CredentialScope {
  return (
    typeof value === "string" &&
    (CREDENTIAL_SCOPES as readonly string[]).includes(value)
  );
}

/** Whether a value is one of the known project roles. */
export function isProjectRole(value: unknown): value is ProjectRole {
  return (
    typeof value === "string" &&
    (ALL_PROJECT_ROLES as readonly string[]).includes(value)
  );
}

/**
 * Expand stored credential scopes into permissions, dropping unknown names.
 *
 * Dropping rather than throwing is deliberate and fail-closed: a scope a newer
 * server wrote that this build does not know grants nothing here, instead of
 * either inventing a permission or refusing every request from a valid token.
 */
export function permissionsOfCredentialScopes(
  scopes: readonly string[],
): Permission[] {
  const granted: Permission[] = [];
  for (const scope of scopes) {
    if (!isCredentialScope(scope)) continue;
    for (const permission of PERMISSIONS_BY_CREDENTIAL_SCOPE[scope]) {
      if (!granted.includes(permission)) granted.push(permission);
    }
  }
  return granted;
}

/** The permissions a role carries, as a fresh array. */
export function permissionsOfRole(role: ProjectRole): Permission[] {
  return [...PERMISSIONS_BY_ROLE[role]];
}

/**
 * Map an OAuth scope string onto an application permission.
 *
 * The `docs.*` namespace an external authorization server issues; this is the
 * single translation point, so an OAuth access token and a PAT reach the
 * authorization policy as the same kind of grant.
 */
export const OAUTH_SCOPE_TO_PERMISSION: Readonly<Record<string, Permission>> = {
  "docs.projects.read": "project:read",
  "docs.projects.create": "project:create",
  "docs.projects.validate": "project:validate",
  "docs.projects.export": "project:export",
  "docs.resources.read": "resource:read",
  "docs.resources.write": "resource:update",
  "docs.resources.create": "resource:create",
  "docs.resources.delete": "resource:delete",
  "docs.diagrams.render": "diagram:render",
  "docs.projects.search": "project:search",
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
