/**
 * The internal user (ADR-040).
 *
 * An authentication provider says *who* someone is; this record says *which
 * user* that is inside our system. The link is `(identityIssuer,
 * identitySubject)`, never an email address: an email can be changed, reused, or
 * reissued by a provider, so it can never be an immutable key.
 *
 * A user carried no password and no credential of any kind. This application
 * does not authenticate anybody itself — it maps an already-authenticated
 * identity onto an internal record and then authorizes that record.
 */

/** An internal user, as stored. */
export interface User {
  /** UUIDv7 primary key. This is the id every other table references. */
  id: string;
  /** The OIDC issuer that asserted this identity (the `iss` claim). */
  identityIssuer: string;
  /** The subject within that issuer (the `sub` claim). Stable and opaque. */
  identitySubject: string;
  /** Display name, refreshed from the provider on each login. */
  displayName: string;
  /** Email, when the provider supplies one. Advisory, never identity. */
  email: string | null;
  createdAt: Date;
  updatedAt: Date;
}

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
