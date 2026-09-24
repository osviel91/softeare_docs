/**
 * The PostgreSQL workspace operation journal.
 *
 * One transaction commits, together:
 *
 * 1. the resource row change (insert, revision bump, path change or delete),
 * 2. the durable operation record describing what the filesystem half must do,
 * 3. the business audit row, and
 * 4. the idempotency record that makes a replay a no-op.
 *
 * That "one transaction" is the whole point: an audit entry can no longer be
 * lost after a successful mutation, and a crash can no longer leave a change
 * with no record of what was intended. The file itself is written by the
 * application service afterwards, and the operation is marked complete only when
 * it is in place.
 *
 * ## The active-operation mutex
 *
 * `workspace_operations_active_unique` (migration 0003) permits one unfinished
 * operation per resource. A second writer's claim therefore fails *before* it
 * touches a file, which is what stops two concurrent writes from reordering each
 * other's bytes. The failure is reported as a retryable `conflict`, never a 500.
 */
import type { SqlClient, SqlValue } from "./sql-client";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";
import { createAuditEventWriter } from "./audit-repository";
import {
  conflict,
  invalid,
  notFound,
  revisionConflict,
} from "../application/errors";
import type {
  WorkspaceClaimResult,
  WorkspaceMutationIntent,
  WorkspaceOperationKind,
  WorkspaceOperationRecord,
  WorkspaceOperationRepository,
  WorkspaceOperationStatus,
} from "../application/ports/workspace-operation-repository";
import type { JsonValue } from "../shared/json/json-value";
import type { ResourceType } from "../domain/workspace/resource-id";
import {
  normalizeResourceMetadata,
  parseResourceMetadata,
} from "../domain/workspace/resource-metadata";

/** PostgreSQL's unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/** Whether a thrown driver error is a unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === UNIQUE_VIOLATION;
}

/** Read a text column. */
function text(row: Record<string, unknown>, key: string): string {
  return String(row[key]);
}

/** Read a nullable text column. */
function optionalText(
  row: Record<string, unknown>,
  key: string,
): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

/** Read a nullable integer column. */
function optionalInteger(
  row: Record<string, unknown>,
  key: string,
): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return Number(value);
}

/** Read a `timestamptz` column. */
function timestamp(row: Record<string, unknown>, key: string): Date {
  const value = row[key];
  return value instanceof Date ? value : new Date(String(value));
}

/** Read a nullable `timestamptz` column. */
function optionalTimestamp(
  row: Record<string, unknown>,
  key: string,
): Date | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(String(value));
}

/** Map one `workspace_operations` row. */
export function toWorkspaceOperation(
  row: Record<string, unknown>,
): WorkspaceOperationRecord {
  return {
    id: text(row, "id"),
    projectId: text(row, "project_id"),
    resourceId: optionalText(row, "resource_id"),
    operation: text(row, "operation") as WorkspaceOperationKind,
    status: text(row, "status") as WorkspaceOperationStatus,
    sourcePath: optionalText(row, "source_path"),
    targetPath: optionalText(row, "target_path"),
    stagedPath: optionalText(row, "staged_path"),
    contentHash: optionalText(row, "content_hash"),
    expectedRevision: optionalInteger(row, "expected_revision"),
    resultingRevision: optionalInteger(row, "resulting_revision"),
    actorType: optionalText(row, "actor_type"),
    actorId: optionalText(row, "actor_id"),
    credentialId: optionalText(row, "credential_id"),
    requestId: optionalText(row, "request_id"),
    idempotencyKey: optionalText(row, "idempotency_key"),
    attempts: Number(row.attempts ?? 0),
    lastError: optionalText(row, "last_error"),
    createdAt: timestamp(row, "created_at"),
    completedAt: optionalTimestamp(row, "completed_at"),
  };
}

/** Options for the journal repository. */
export interface WorkspaceOperationRepositoryOptions {
  newId?: IdGenerator;
}

/** Build the journal over a SQL client. */
export function createWorkspaceOperationRepository(
  client: SqlClient,
  options: WorkspaceOperationRepositoryOptions = {},
): WorkspaceOperationRepository {
  const newId = options.newId ?? createIdGenerator();
  const writeAudit = createAuditEventWriter(newId);

  /** Insert the journal row, translating the active-operation mutex. */
  async function insertOperation(
    tx: SqlClient,
    intent: WorkspaceMutationIntent,
    resultingRevision: number | null,
  ): Promise<WorkspaceOperationRecord> {
    try {
      const result = await tx.query(
        `INSERT INTO workspace_operations
           (id, project_id, resource_id, operation, status, source_path,
            target_path, staged_path, content_hash, expected_revision,
            resulting_revision, actor_type, actor_id, credential_id, request_id,
            idempotency_key)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15)
         RETURNING *`,
        [
          intent.operationId,
          intent.projectId,
          intent.resourceId,
          intent.operation,
          intent.sourcePath ?? null,
          intent.targetPath,
          intent.stagedPath ?? null,
          intent.contentHash ?? null,
          intent.expectedRevision,
          resultingRevision,
          intent.audit.actorType ?? "user",
          intent.audit.actorId ?? intent.audit.subjectUserId,
          intent.audit.credentialId ?? null,
          intent.audit.requestId ?? null,
          intent.idempotencyKey ?? null,
        ],
      );
      return toWorkspaceOperation(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          "Another operation is still finishing on this resource. Re-read it and retry in a moment.",
          { retryable: true, reason: "operation_in_progress" },
        );
      }
      throw error;
    }
  }

  /** Record the in-progress idempotency claim, if the caller supplied a key. */
  async function claimIdempotency(
    tx: SqlClient,
    intent: WorkspaceMutationIntent,
  ): Promise<void> {
    if (!intent.idempotencyKey) return;
    try {
      await tx.query(
        `INSERT INTO idempotency_records
           (actor_id, project_id, idempotency_key, operation, status)
         VALUES ($1, $2, $3, $4, 'in_progress')`,
        [
          intent.audit.actorId ?? intent.audit.subjectUserId ?? "system",
          intent.projectId,
          intent.idempotencyKey,
          intent.operation,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          "A mutation with this idempotencyKey is already in progress. Retry shortly.",
          { retryable: true, reason: "idempotency_in_progress" },
        );
      }
      throw error;
    }
  }

  /** The stored result of a completed idempotent mutation, or `undefined`. */
  async function replayOf(
    tx: SqlClient,
    intent: WorkspaceMutationIntent,
  ): Promise<WorkspaceClaimResult | undefined> {
    if (!intent.idempotencyKey) return undefined;
    const result = await tx.query(
      `SELECT status, result FROM idempotency_records
        WHERE actor_id = $1 AND project_id = $2 AND idempotency_key = $3`,
      [
        intent.audit.actorId ?? intent.audit.subjectUserId ?? "system",
        intent.projectId,
        intent.idempotencyKey,
      ],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (String(row.status) === "completed") {
      return { kind: "replayed", result: (row.result ?? null) as JsonValue };
    }
    throw conflict(
      "A mutation with this idempotencyKey is already in progress. Retry shortly.",
      { retryable: true, reason: "idempotency_in_progress" },
    );
  }

  /** Load a resource row and refuse a stale or absent one. */
  async function requireRow(
    tx: SqlClient,
    projectId: string,
    resourceId: string,
    expectedRevision: number | null,
  ): Promise<Record<string, unknown>> {
    const locked = await tx.query(
      `SELECT * FROM resources
        WHERE project_id = $1 AND id = $2
        FOR UPDATE`,
      [projectId, resourceId],
    );
    const row = locked.rows[0];
    if (!row) throw notFound(`No resource with id ${resourceId}.`);
    const current = Number(row.revision);
    if (expectedRevision !== null && current !== expectedRevision) {
      throw revisionConflict(expectedRevision, current);
    }
    return row;
  }

  const repository: WorkspaceOperationRepository = {
    async claim(intent) {
      if (intent.operation === "create" && !intent.resourceType) {
        throw invalid("A create operation must name the resource type.");
      }
      return client.transaction(async (tx) => {
        const replay = await replayOf(tx, intent);
        if (replay !== undefined) return replay;

        let resultingRevision: number | null = null;

        switch (intent.operation) {
          case "create": {
            try {
              await tx.query(
                `INSERT INTO resources (id, project_id, path, type, metadata)
                 VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb))`,
                [
                  intent.resourceId,
                  intent.projectId,
                  intent.targetPath,
                  intent.resourceType as ResourceType,
                  intent.metadata === undefined
                    ? null
                    : JSON.stringify(intent.metadata),
                ],
              );
            } catch (error) {
              if (isUniqueViolation(error)) {
                throw conflict(
                  `A resource already exists at "${intent.targetPath}".`,
                  { reason: "path_taken" },
                );
              }
              throw error;
            }
            resultingRevision = 1;
            break;
          }

          case "update": {
            const row = await requireRow(
              tx,
              intent.projectId,
              intent.resourceId,
              intent.expectedRevision,
            );
            resultingRevision = Number(row.revision) + 1;
            await tx.query(
              `UPDATE resources
                  SET revision = revision + 1,
                      metadata = COALESCE($3::jsonb, metadata),
                      updated_at = now()
                WHERE project_id = $1 AND id = $2`,
              [
                intent.projectId,
                intent.resourceId,
                intent.metadata === undefined
                  ? null
                  : JSON.stringify(intent.metadata),
              ],
            );
            break;
          }

          case "move": {
            const row = await requireRow(
              tx,
              intent.projectId,
              intent.resourceId,
              intent.expectedRevision,
            );
            const occupant = await tx.query(
              `SELECT id FROM resources
                WHERE project_id = $1 AND path = $2 AND id <> $3`,
              [intent.projectId, intent.targetPath, intent.resourceId],
            );
            if (occupant.rows[0]) {
              throw conflict(
                `A resource already exists at "${intent.targetPath}".`,
                { reason: "path_taken" },
              );
            }
            resultingRevision = Number(row.revision) + 1;
            try {
              await tx.query(
                `UPDATE resources
                    SET path = $3, revision = revision + 1, updated_at = now()
                  WHERE project_id = $1 AND id = $2`,
                [intent.projectId, intent.resourceId, intent.targetPath],
              );
            } catch (error) {
              if (isUniqueViolation(error)) {
                throw conflict(
                  `A resource already exists at "${intent.targetPath}".`,
                  { reason: "path_taken" },
                );
              }
              throw error;
            }
            break;
          }

          case "delete": {
            await requireRow(
              tx,
              intent.projectId,
              intent.resourceId,
              intent.expectedRevision,
            );
            await tx.query(
              "DELETE FROM resources WHERE project_id = $1 AND id = $2",
              [intent.projectId, intent.resourceId],
            );
            break;
          }
        }

        if (intent.operation !== "delete") {
          let content = intent.content;
          if (content === undefined) {
            const previous = await tx.query(
              `SELECT content FROM resource_revisions
                WHERE resource_id = $1 AND revision = $2`,
              [intent.resourceId, resultingRevision! - 1],
            );
            content = previous.rows[0]?.content as string | undefined;
          }
          if (content === undefined) {
            throw invalid(
              `Resource ${intent.resourceId} has no snapshot for revision ${resultingRevision! - 1}.`,
            );
          }
          const resource = await tx.query(
            "SELECT type, metadata FROM resources WHERE id = $1",
            [intent.resourceId],
          );
          const resourceRow = resource.rows[0];
          const metadata = normalizeResourceMetadata(
            intent.metadata ?? parseResourceMetadata(resourceRow?.metadata),
          );
          await tx.query(
            `INSERT INTO resource_revisions
              (resource_id, revision, content, type, metadata, authorship)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
            [
              intent.resourceId,
              resultingRevision,
              content,
              String(intent.resourceType ?? resourceRow?.type),
              JSON.stringify(metadata),
              JSON.stringify(intent.authorship ?? { kind: "system" }),
            ],
          );
        }

        if (intent.proposalMerge !== undefined) {
          const merged = await tx.query(
            `UPDATE change_proposals
                SET status = 'merged',
                    proposal_version = proposal_version + 1,
                    merge_authorship = $4::jsonb,
                    merged_at = now(),
                    merged_revision = $5,
                    updated_at = now()
              WHERE id = $1 AND resource_id = $2 AND proposal_version = $3
                AND status = 'open'
            RETURNING id`,
            [
              intent.proposalMerge.proposalId,
              intent.resourceId,
              intent.proposalMerge.expectedVersion,
              JSON.stringify(intent.proposalMerge.actor),
              intent.proposalMerge.resultingRevision,
            ],
          );
          if (merged.rows.length === 0) {
            throw conflict(
              "The change proposal changed before it could be merged. Re-read it and retry.",
              { reason: "proposal_changed", retryable: true },
            );
          }
        }

        const operation = await insertOperation(tx, intent, resultingRevision);
        // The audit row commits with the change it describes, so a successful
        // mutation can no longer be missing from the trail.
        await writeAudit(tx, intent.audit);
        await claimIdempotency(tx, intent);
        return { kind: "claimed", operation };
      });
    },

    async finalize(operationId, result) {
      await client.transaction(async (tx) => {
        await tx.query(
          `UPDATE workspace_operations
              SET status = 'completed', completed_at = now(), updated_at = now(),
                  attempts = attempts + 1, last_error = NULL
            WHERE id = $1`,
          [operationId],
        );
        await tx.query(
          `UPDATE idempotency_records r
              SET status = 'completed', completed_at = now(), result = $2::jsonb
             FROM workspace_operations o
            WHERE o.id = $1
              AND r.actor_id = o.actor_id
              AND r.project_id = o.project_id
              AND r.idempotency_key = o.idempotency_key`,
          [operationId, result === null ? null : JSON.stringify(result)],
        );
      });
    },

    async markProcessing(operationId) {
      await client.query(
        `UPDATE workspace_operations
            SET status = 'processing', updated_at = now(), attempts = attempts + 1
          WHERE id = $1 AND status <> 'completed'`,
        [operationId],
      );
    },

    async settle(operationId, status, error) {
      await client.query(
        `UPDATE workspace_operations
            SET status = $2, last_error = $3, updated_at = now(),
                attempts = attempts + 1
          WHERE id = $1`,
        [operationId, status, error],
      );
    },

    async restore(operationId, error) {
      await client.transaction(async (tx) => {
        const found = await tx.query(
          "SELECT * FROM workspace_operations WHERE id = $1",
          [operationId],
        );
        const row = found.rows[0];
        if (!row) return;
        const operation = toWorkspaceOperation(row);
        if (
          operation.operation === "move" &&
          operation.sourcePath !== null &&
          operation.resourceId !== null
        ) {
          // The revision is deliberately untouched: it is a monotonic claim
          // counter, and reusing a number would reopen the race the claim closed.
          await tx.query(
            `UPDATE resources
                SET path = $3, updated_at = now()
              WHERE project_id = $1 AND id = $2`,
            [operation.projectId, operation.resourceId, operation.sourcePath],
          );
        }
        await tx.query(
          `UPDATE workspace_operations
              SET status = 'failed', last_error = $2, updated_at = now(),
                  attempts = attempts + 1
            WHERE id = $1`,
          [operationId, error],
        );
      });
    },

    async find(operationId) {
      const result = await client.query(
        "SELECT * FROM workspace_operations WHERE id = $1",
        [operationId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toWorkspaceOperation(row);
    },

    async unfinished(limit) {
      const result = await client.query(
        `SELECT * FROM workspace_operations
          WHERE status IN ('pending', 'processing', 'compensating')
          ORDER BY created_at ASC
          LIMIT $1`,
        [Math.max(1, Math.floor(limit))],
      );
      return result.rows.map(toWorkspaceOperation);
    },

    async hasUnfinished(projectId, resourceId) {
      const result = await client.query(
        `SELECT 1 FROM workspace_operations
          WHERE project_id = $1 AND resource_id = $2
            AND status IN ('pending', 'processing', 'compensating')
          LIMIT 1`,
        [projectId, resourceId],
      );
      return result.rows.length > 0;
    },

    async purgeCompleted(before) {
      const result = await client.query(
        `DELETE FROM workspace_operations
          WHERE status IN ('completed', 'failed') AND updated_at < $1`,
        [before as SqlValue],
      );
      return result.rowCount;
    },

    async purgeIdempotency(before) {
      const result = await client.query(
        "DELETE FROM idempotency_records WHERE created_at < $1",
        [before as SqlValue],
      );
      return result.rowCount;
    },
  };

  return repository;
}
