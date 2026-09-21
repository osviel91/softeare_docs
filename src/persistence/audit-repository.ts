/**
 * The PostgreSQL audit repository (ADR-040 / mission Phase 10).
 *
 * This is the *implementation* of a port defined in the application layer
 * (`src/application/ports/audit-repository.ts`); its types are re-exported here
 * so existing callers keep working. See that file for why the audit trail exists
 * and what is deliberately never written to it.
 *
 * The writer fills the id and timestamp itself, so a caller cannot backdate a row
 * or choose its own primary key.
 */
import type { SqlClient } from "./sql-client";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";
import type { AuthType } from "../application/context";
import type { JsonObject } from "../shared/json/json-value";
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditEvent,
  type AuditRecord,
  type AuditRepository,
} from "../application/ports/audit-repository";

export { AUDIT_ACTIONS };
export type { AuditAction, AuditEvent, AuditRecord, AuditRepository };

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
         (id, user_id, actor_type, actor_id, credential_id, auth_type, project_id,
          resource_id, action, request_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       RETURNING *`,
      [
        id,
        event.subjectUserId,
        event.actorType ?? "user",
        event.actorId ?? event.subjectUserId,
        event.credentialId ?? null,
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
  const subjectUserId =
    value("user_id") === null ? null : String(value("user_id"));
  return {
    id: String(value("id")),
    occurredAt:
      value("occurred_at") instanceof Date
        ? (value("occurred_at") as Date)
        : new Date(String(value("occurred_at"))),
    subjectUserId,
    actorType:
      value("actor_type") === null || value("actor_type") === undefined
        ? "user"
        : (String(value("actor_type")) as AuditEvent["actorType"]),
    actorId:
      value("actor_id") === null || value("actor_id") === undefined
        ? subjectUserId
        : String(value("actor_id")),
    credentialId:
      value("credential_id") === null || value("credential_id") === undefined
        ? null
        : String(value("credential_id")),
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
