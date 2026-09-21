/**
 * The authorization policy: the one place a principal is turned into a decision
 * (ADR-042).
 *
 * This is the layer between "a request arrived with a principal" and "a use case
 * runs". It resolves the principal's role in a project, checks any restriction
 * the credential carries, applies the domain decision function, and reports a
 * refusal as an {@link ApplicationError} the transport can map.
 *
 * Two rules it exists to enforce:
 *
 * 1. **Fail closed.** A repository failure while resolving a role is a refusal,
 *    never an implicit grant. There is no `catch` that returns "allowed".
 * 2. **Project-restricted credentials are invisible, not forbidden.** A PAT
 *    limited to project A that addresses project B is answered exactly as a
 *    project that does not exist, so a credential cannot be used to enumerate
 *    project ids.
 *
 * Use cases call `requirePermission(context, projectId, "resource:write")` and
 * nothing else. That single call is why the HTTP API and the MCP adapter cannot
 * disagree about who may do what: there is only one implementation to disagree
 * with.
 */
import type { ApplicationContext, Principal } from "./context";
import { forbidden, notFound } from "./errors";
import {
  authorize,
  grantedPermissions,
  roleAllows,
} from "../domain/access/authorize";
import type { Permission, ProjectRole } from "../domain/access/permissions";

/** The roles that may read a project. */
export const READ_ROLES: readonly ProjectRole[] = ["OWNER", "EDITOR", "VIEWER"];
/** The roles that may change a project's resources. */
export const WRITE_ROLES: readonly ProjectRole[] = ["OWNER", "EDITOR"];
/** The roles that may change a project or its membership. */
export const ADMIN_ROLES: readonly ProjectRole[] = ["OWNER"];

/** Why a request was refused. */
export type RefusalReason =
  /** The project does not exist, or the principal is not a member of it. */
  | "not_found"
  /** The credential is restricted to other projects. */
  | "restricted"
  /**
   * The credential itself does not carry the required permission.
   *
   * Distinct from `forbidden`: a read-only agent token would be refused a write
   * even in a project where it is an owner, because the *credential* was never
   * granted that capability. Both map to `403`, for the same reason a viewer's
   * refusal does.
   */
  | "scope"
  /** The principal is a member, but the role is too weak. */
  | "forbidden";

/**
 * The outcome of resolving a principal against a project.
 *
 * An allowed outcome carries the project record it resolved, so a use case does
 * not read the same row a second time; a refusal carries *why*, so the throwing
 * wrapper can answer "invisible" and "too weak" differently without a third
 * query.
 */
export type PermissionOutcome<P extends AuthorizedProject = AuthorizedProject> =
  | { allowed: true; role: ProjectRole; project: P }
  | {
      allowed: false;
      reason: RefusalReason;
      role: ProjectRole | null;
      missing: Permission;
    };

/** The part of a project the policy needs: its authoritative identifier. */
export interface AuthorizedProject {
  id: string;
}

/** Resolve projects for the policy. Injectable, so a test can force a failure. */
export interface AuthorizationRepository {
  findById(id: string): Promise<AuthorizedProject | null>;
  roleOf(projectId: string, userId: string): Promise<ProjectRole | null>;
}

/** The policy. */
export interface AuthorizationPolicy<
  P extends AuthorizedProject = AuthorizedProject,
> {
  /**
   * Decide a request without throwing.
   *
   * Returns a {@link PermissionOutcome} rather than an error, so a caller that
   * only wants to ask "may they?" — a UI, an audit record, a tool listing — can
   * do so without catching. The outcome carries *why* it was refused, which is
   * what lets the throwing wrapper distinguish "invisible" from "too weak".
   */
  decide(
    context: ApplicationContext,
    projectId: string,
    permission: Permission,
  ): Promise<PermissionOutcome<P>>;

  /**
   * Decide a request and refuse it by throwing.
   *
   * @throws {ApplicationError} `not_found` when the project does not exist or is
   *   invisible to this principal, `forbidden` when the role is too weak.
   */
  requirePermission(
    context: ApplicationContext,
    projectId: string,
    permission: Permission,
  ): Promise<{ allowed: true; role: ProjectRole; project: P }>;

  /** Whether a principal holds one of the given roles in a project. */
  hasRole(
    context: ApplicationContext,
    projectId: string,
    roles: readonly ProjectRole[],
  ): Promise<boolean>;
}

/** Whether a credential is restricted to a specific set of projects. */
export function restrictionOf(principal: Principal): readonly string[] | null {
  const restricted = principal.projectIds;
  if (restricted === undefined || restricted.length === 0) return null;
  return restricted;
}

/** Whether a credential may address this project at all. */
export function credentialAllowsProject(
  principal: Principal,
  projectId: string,
): boolean {
  const restricted = restrictionOf(principal);
  return restricted === null || restricted.includes(projectId);
}

/**
 * Whether a credential carries a permission at all.
 *
 * Two grants must line up before anything happens: the *credential* must carry
 * the capability (a read-only agent token never does), and the caller's *role*
 * in the project must carry it too. A session is unrestricted by construction —
 * a person at a browser is limited by membership, which is what roles express —
 * so it carries the whole vocabulary.
 */
export function credentialGrants(
  principal: Principal,
  permission: Permission,
): boolean {
  return principal.scopes.includes(permission);
}

/** Build the policy over the project repository. */
export function createAuthorizationPolicy<
  P extends AuthorizedProject = AuthorizedProject,
>(projects: AuthorizationRepository): AuthorizationPolicy<P> {
  const policy: AuthorizationPolicy<P> = {
    async decide(context, projectId, permission) {
      if (!credentialAllowsProject(context.principal, projectId)) {
        return {
          allowed: false,
          reason: "restricted",
          role: null,
          missing: permission,
        };
      }
      // The credential is checked before membership: a token that was never
      // granted a capability must not be able to probe which projects exist.
      if (!credentialGrants(context.principal, permission)) {
        return {
          allowed: false,
          reason: "scope",
          role: null,
          missing: permission,
        };
      }
      let project: P | null;
      let role: ProjectRole | null;
      try {
        project = (await projects.findById(projectId)) as P | null;
        role =
          project === null
            ? null
            : await projects.roleOf(projectId, context.principal.userId);
      } catch {
        // A failure to read membership is a refusal. This is the one place an
        // error is swallowed, and it is swallowed in the safe direction: the
        // alternative turns a database blip into a 500 for a request that should
        // simply have been denied.
        return {
          allowed: false,
          reason: "not_found",
          role: null,
          missing: permission,
        };
      }
      if (project === null || role === null) {
        return {
          allowed: false,
          reason: "not_found",
          role: null,
          missing: permission,
        };
      }
      const decision = authorize({ role, required: permission });
      return decision.allowed
        ? { allowed: true, role: decision.role, project }
        : {
            allowed: false,
            reason: "forbidden",
            role: decision.role,
            missing: decision.missing,
          };
    },

    async requirePermission(context, projectId, permission) {
      const outcome = await policy.decide(context, projectId, permission);
      if (outcome.allowed) return outcome;

      if (outcome.reason === "scope") {
        throw forbidden(
          `This credential does not carry the ${outcome.missing} permission.`,
        );
      }
      if (outcome.reason === "forbidden" && outcome.role !== null) {
        throw forbidden(
          `Your role in this project (${outcome.role}) does not permit ${outcome.missing}.`,
        );
      }
      // "not_found" and "restricted" answer identically: a credential must not
      // be able to tell a project it cannot see from one that does not exist.
      throw notFound(`No project with id ${projectId}.`);
    },

    async hasRole(context, projectId, roles) {
      const outcome = await policy.decide(context, projectId, "project:read");
      if (!outcome.allowed) {
        return (
          outcome.reason === "forbidden" &&
          outcome.role !== null &&
          roles.includes(outcome.role)
        );
      }
      return roles.includes(outcome.role);
    },
  };

  return policy;
}

/** Re-exported so a use case can name a decision without importing the domain. */
export { authorize, grantedPermissions, roleAllows };
