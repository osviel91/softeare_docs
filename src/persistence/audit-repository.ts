/**
 * The audit trail (ADR-040 / mission Phase 10).
 *
 * When agents can mutate documentation, "who changed this, and how did they
 * authenticate?" has to be answerable after the fact. Every application use case
 * that changes something records one row here, inside the same transaction as
 * the change wherever possible, so an audit row and the change it describes
 * cannot disagree.
 *
 * What is deliberately **never** written here:
 *
 * - a raw access token, PAT secret or session cookie value;
 * - a password (this application never sees one);
 * - a document's contents.
 *
 * The writer takes an {@link AuditEvent} shape and fills the id and timestamp
 * itself, so a caller cannot backdate a row or choose its own primary key.
 */
import type { AuthType } from "../application/context";
import type { JsonObject } from "../shared/json/json-value";
import type { SqlClient } from "./sql-client";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";

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
  "token.created",
  "token.revoked",
  "mcp.tool.executed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** One audit entry, before it is written. */
export interface AuditEvent {
  action: AuditAction;
  /** The user who acted. `null` only for a system action. */
  userId: string | null;
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

/** Cap on how many entries one listing returns, so a query cannot be unbounded. */
const MAX_LIMIT = 500;

/** The repository over a `SqlClient`. */
export function createAuditRepository(
  client: SqlClient,
  options: { newId?: IdGenerator } = {},
): AuditRepository {
  const newId = options.newId ?? createIdGenerator();

  const insert = async (tx: SqlClient, event: AuditEvent, id: string) => {
    const result = await tx.query(
      `INSERT INTO audit_events
         (id, user_id, auth_type, project_id, resource_id, action, request_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING *`,
      [
        id,
        event.userId,
        event.authType,
        event.projectId ?? null,
        event.resourceId ?? null,
        event.action,
        event.requestId ?? null,
        JSON.stringify(event.detail ?? {}),
      ],
    );
    return toAuditRecord(result.rows[0]);
  };

  return {
    async record(event) {
      return insert(client, event, newId());
    },

    async recordAll(events) {
      if (events.length === 0) return [];
      const ids = events.map(() => newId());
      return client.transaction(async (tx) => {
        const written: AuditRecord[] = [];
        for (const [index, event] of events.entries()) {
          written.push(await insert(tx, event, ids[index]));
        }
        return written;
      });
    },

    async listForProject(projectId, limit) {
      const result = await client.query(
        `SELECT * FROM audit_events
          WHERE project_id = $1
          ORDER BY occurred_at DESC, id DESC
          LIMIT $2`,
        [projectId, clampLimit(limit)],
      );
      return result.rows.map(toAuditRecord);
    },

    async listForUser(userId, limit) {
      const result = await client.query(
        `SELECT * FROM audit_events
          WHERE user_id = $1
          ORDER BY occurred_at DESC, id DESC
          LIMIT $2`,
        [userId, clampLimit(limit)],
      );
      return result.rows.map(toAuditRecord);
    },
  };
}

/** Keep a requested limit inside a sane range. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

/** Map an `audit_events` row. */
function toAuditRecord(row: Record<string, unknown>): AuditRecord {
  const value = (key: string): unknown => row[key];
  return {
    id: String(value("id")),
    occurredAt:
      value("occurred_at") instanceof Date
        ? (value("occurred_at") as Date)
        : new Date(String(value("occurred_at"))),
    userId: value("user_id") === null ? null : String(value("user_id")),
    authType: String(value("auth_type")) as AuthType,
    projectId:
      value("project_id") === null ? null : String(value("project_id")),
    resourceId:
      value("resource_id") === null ? null : String(value("resource_id")),
    action: String(value("action")) as AuditAction,
    requestId:
      value("request_id") === null ? null : String(value("request_id")),
    detail:
      typeof value("detail") === "object" && value("detail") !== null
        ? (value("detail") as JsonObject)
        : {},
  };
}
