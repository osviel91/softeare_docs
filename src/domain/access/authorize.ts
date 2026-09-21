/**
 * The authorization decision (ADR-042).
 *
 * Authentication answers *who are you*; this answers *may you do this*. They are
 * separate on purpose: a valid session that belongs to a VIEWER authenticates
 * perfectly and is still refused a write.
 *
 * The function is pure and tiny, which is the point. Every role→permission table
 * already lives in `permissions.ts`; what was missing is the single place that
 * compares a requested permission against what a role grants. Controllers never
 * call it, use cases never call it — the *policy* calls it (see
 * `src/application/authorization.ts`), so an MCP tool cannot reach a use case
 * without passing through exactly the same decision a browser request does.
 *
 * A note on what is deliberately absent: there is no `isOwner`, no `role ===`,
 * and no HTTP status. A caller learns *whether* an action is allowed and, when it
 * is not, receives the permission that was missing — never a boolean it might
 * invert by accident.
 */
import type { Permission, ProjectRole } from "./permissions";
import { PERMISSIONS_BY_ROLE } from "./permissions";

/** An authorization decision. */
export type AccessDecision =
  | { allowed: true; role: ProjectRole }
  | { allowed: false; role: ProjectRole; missing: Permission };

/** What a caller is trying to do. */
export interface AccessRequest {
  /** The role the caller holds in the project, or `null` when they hold none. */
  role: ProjectRole | null;
  /** The permission the operation requires. */
  required: Permission;
}

/**
 * Compare a role against a required permission.
 *
 * A caller with no role is refused with `missing` naming the permission, so the
 * two "no" cases — "not a member" and "member without this capability" — are
 * distinguishable by the caller while still being one code path here.
 */
export function authorize(request: AccessRequest): AccessDecision {
  const { role, required } = request;
  if (role === null) {
    return { allowed: false, role: "VIEWER", missing: required };
  }
  const granted = PERMISSIONS_BY_ROLE[role];
  return granted.includes(required)
    ? { allowed: true, role }
    : { allowed: false, role, missing: required };
}

/** Whether a role carries a permission. */
export function roleAllows(role: ProjectRole, permission: Permission): boolean {
  return PERMISSIONS_BY_ROLE[role].includes(permission);
}

/** The permissions a role carries, for a UI that explains a refusal. */
export function grantedPermissions(role: ProjectRole): readonly Permission[] {
  return PERMISSIONS_BY_ROLE[role];
}
