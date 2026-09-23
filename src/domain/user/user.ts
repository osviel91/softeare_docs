/**
 * The internal user (ADR-040).
 *
 * An authentication provider says *who* someone is; this record says *which
 * user* that is inside our system. Provider identities live separately because a
 * user may have more than one authentication method.
 *
 * Authentication methods are separate from this record. This record owns the
 * approval state and platform-admin flag shared by every method.
 */

/** An internal user, as stored. */
export interface User {
  /** UUIDv7 primary key. This is the id every other table references. */
  id: string;
  /** Display name, refreshed from the provider on each login. */
  displayName: string;
  /** Email, when the provider supplies one. Advisory, never identity. */
  email: string | null;
  status: AccountStatus;
  platformAdmin: boolean;
  activatedAt: Date | null;
  activatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Whether a user may use server workspaces. */
export type AccountStatus = "PENDING" | "ACTIVE" | "SUSPENDED";

/** The identity claims an OIDC provider asserted, before mapping to a user. */
export interface ExternalIdentity {
  /** The `iss` claim. Compared exactly, after normalisation. */
  issuer: string;
  /** The `sub` claim. */
  subject: string;
  displayName: string;
  email: string | null;
}

/** How a user is looked up: by identity, or by internal id. */
export type UserLookup =
  | { by: "identity"; issuer: string; subject: string }
  | { by: "id"; id: string };
