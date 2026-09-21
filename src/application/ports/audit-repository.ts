/**
 * The audit port (Phase 4D).
 *
 * When agents can mutate documentation, "who changed this, and how did they
 * authenticate?" has to be answerable after the fact. Every application use case
 * that changes something records one row here, so an audit row and the change it
 * describes cannot disagree.
 *
 * What is deliberately **never** written through this port:
 *
 * - a raw access token, PAT secret or session cookie value;
 * - a password (this application never sees one);
 * - a document's contents.
 *
 * The port takes an {@link AuditEvent} shape; the implementation fills in the id
 * and timestamp itself, so a caller cannot backdate a row or choose its own
 * primary key.
 *
 * Moving the definition here (Phase 4D) is what lets `project-catalog` depend on
 * a port instead of on the PostgreSQL module that implements it.
 */
import type { AuthType } from "../context";
import type { JsonObject } from "../../shared/json/json-value";

/**
 * The actions the audit trail records.
 *
 * A closed vocabulary rather than free text: an action nobody can spell two ways
 * is an action that can be counted.
 */
export const AUDIT_ACTIONS = [
  "project.created",
  "project.updated",
  "project.deleted",
  "project.member.added",
  "project.member.removed",
  "resource.created",
  "resource.updated",
  "resource.moved",
  "resource.deleted",
  "agent.created",
  "agent.updated",
  "agent.disabled",
  "credential.created",
  "credential.revoked",
  "credential.rotated",
  "mcp.tool.executed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** One audit entry, before it is written. */
export interface AuditEvent {
  action: AuditAction;
  /**
   * The user whose authority bounded the request.
   *
   * For a session this is the signed-in user; for an agent credential it is the
   * agent's owner. `null` only for a system action.
   */
  subjectUserId: string | null;
  /**
   * Who actually acted: `user`, `agent`, or `system`.
   *
   * Distinct from {@link subjectUserId} because an agent acts *on behalf of* its
   * owner, and the trail has to say which.
   */
  actorType?: "user" | "agent" | "system";
  /** The acting user id or agent id, matching {@link actorType}. */
  actorId?: string | null;
  /** The credential an agent actor authenticated with, when there is one. */
  credentialId?: string | null;
  authType: AuthType;
  projectId?: string | null;
  resourceId?: string | null;
  requestId?: string | null;
  /** Extra context. Never a secret, never document content. */
  detail?: JsonObject;
}

/** One stored audit entry. */
export interface AuditRecord extends AuditEvent {
  id: string;
  occurredAt: Date;
}

export interface AuditRepository {
  /** Append an entry. */
  record(event: AuditEvent): Promise<AuditRecord>;

  /**
   * Append several entries atomically.
   *
   * Used when one use case produces more than one event (a move that rewrites a
   * reference records both), so the trail never shows half a story.
   */
  recordAll(events: readonly AuditEvent[]): Promise<AuditRecord[]>;

  /** The most recent entries for a project, newest first. */
  listForProject(projectId: string, limit?: number): Promise<AuditRecord[]>;

  /** The most recent entries by a user, newest first. */
  listForUser(userId: string, limit?: number): Promise<AuditRecord[]>;
}
