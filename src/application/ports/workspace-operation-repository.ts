/**
 * The workspace operation journal port.
 *
 * A mutation of a server resource changes two stores that cannot share a
 * transaction: the `resources` row in PostgreSQL and the document's bytes on the
 * project volume. This port is the durable half — it records *what is about to
 * happen* atomically with the row change, so the filesystem half can be
 * completed, retried or compensated after the fact.
 *
 * The port is deliberately not a generic "transaction" abstraction. It exposes
 * exactly the four mutations a project resource has, because the whole point is
 * that there is one authoritative implementation of "claim revision N, write the
 * bytes, settle the operation" rather than a transaction handle every call site
 * could use to reinvent it.
 *
 * The definition lives in the application layer; `src/persistence` implements it
 * against PostgreSQL. The dependency arrow therefore points persistence →
 * application, exactly as ADR-039 requires.
 */
import type { JsonValue } from "../../shared/json/json-value";
import type { AuditEvent } from "./audit-repository";
import type { ResourceType } from "../../domain/workspace/resource-id";
import type { ResourceMetadata } from "../../domain/workspace/resource-metadata";
import type { ResourceAuthorship } from "../../domain/workspace/resource-revision";

/** The mutations the journal records. */
export type WorkspaceOperationKind = "create" | "update" | "move" | "delete";

/**
 * Where an operation is in its lifecycle.
 *
 * - `pending` — the intent and the row change are committed; the filesystem step
 *   has not run (or has not been confirmed) yet.
 * - `processing` — a worker has taken it (used by the recovery pass to claim an
 *   operation before acting on it).
 * - `completed` — both halves agree.
 * - `failed` — the operation was abandoned after compensation; `last_error`
 *   explains why, and no recovery will touch it again.
 * - `compensating` — the filesystem step failed in a way that still needs
 *   unwinding, so recovery must keep trying to restore the old state.
 */
export type WorkspaceOperationStatus =
  "pending" | "processing" | "completed" | "failed" | "compensating";

/** One durable operation record. Never carries a document's contents. */
export interface WorkspaceOperationRecord {
  id: string;
  projectId: string;
  resourceId: string | null;
  operation: WorkspaceOperationKind;
  status: WorkspaceOperationStatus;
  /** The path the document was at before a move or delete. */
  sourcePath: string | null;
  /** The path the document should end up at. */
  targetPath: string | null;
  /** The hidden staging path the new bytes were written to, if any. */
  stagedPath: string | null;
  /** SHA-256 of the intended content, so recovery can verify a staged file. */
  contentHash: string | null;
  expectedRevision: number | null;
  resultingRevision: number | null;
  actorType: string | null;
  actorId: string | null;
  credentialId: string | null;
  requestId: string | null;
  idempotencyKey: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

/** The intent a caller asks the journal to claim. */
export interface WorkspaceMutationIntent {
  operationId: string;
  projectId: string;
  resourceId: string;
  operation: WorkspaceOperationKind;
  /** The path before the mutation (move/delete). */
  sourcePath?: string | null;
  /** The path after the mutation (create/update/move). */
  targetPath: string;
  /** A hidden staging path holding the new bytes, when the operation has any. */
  stagedPath?: string | null;
  /** SHA-256 of the intended content. */
  contentHash?: string | null;
  /** The revision the caller last read; `null` for a create. */
  expectedRevision: number | null;
  /** The resource type, required by a create. */
  resourceType?: ResourceType;
  metadata?: ResourceMetadata;
  /** Exact content of the logical state being committed. */
  content?: string;
  authorship?: ResourceAuthorship;
  /** The audit entry to commit in the same transaction as the row change. */
  audit: AuditEvent;
  /**
   * An optional retry key. `actorId + projectId + idempotencyKey` identifies one
   * logical mutation, so a replay returns the first result instead of repeating
   * the effect.
   */
  idempotencyKey?: string | null;
  /** An open proposal transition committed with the canonical update. */
  proposalMerge?: {
    proposalId: string;
    expectedVersion: number;
    actor: ResourceAuthorship;
    resultingRevision: number;
  };
}

/** What a claim produced. */
export type WorkspaceClaimResult =
  | { kind: "claimed"; operation: WorkspaceOperationRecord }
  /**
   * A completed operation with this idempotency key already ran; `result` is the
   * value the first run returned, so a retry is observably identical.
   */
  | { kind: "replayed"; result: JsonValue | null };

export interface WorkspaceOperationRepository {
  /**
   * Commit the intent, the row change and the audit entry in one transaction.
   *
   * @throws {ApplicationError} `conflict` when the revision is stale, the target
   *   path is taken or another operation on the resource is still unfinished;
   *   `not_found` when the resource does not exist; `invalid` when the intent is
   *   malformed.
   */
  claim(intent: WorkspaceMutationIntent): Promise<WorkspaceClaimResult>;

  /** Mark an operation complete and store the result a retry will replay. */
  finalize(operationId: string, result: JsonValue | null): Promise<void>;

  /** Take an unfinished operation for the recovery pass. */
  markProcessing(operationId: string): Promise<void>;

  /** Record a failure or the need to compensate; never throws for a missing row. */
  settle(
    operationId: string,
    status: "failed" | "compensating",
    error: string | null,
  ): Promise<void>;

  /**
   * Undo a move's database half because its filesystem half could not run.
   *
   * Restores `resources.path` to the operation's `source_path` — deliberately
   * *without* touching the revision, which is a monotonic claim counter — and
   * marks the operation `failed`. Throws if the restore could not be committed,
   * so the caller can leave the operation `compensating` for recovery instead of
   * claiming a clean rollback that never happened.
   */
  restore(operationId: string, error: string | null): Promise<void>;

  /** One operation by id. */
  find(operationId: string): Promise<WorkspaceOperationRecord | null>;

  /** Unfinished operations, oldest first — the recovery pass's work list. */
  unfinished(limit: number): Promise<WorkspaceOperationRecord[]>;

  /** Whether an unfinished operation exists for a resource. */
  hasUnfinished(projectId: string, resourceId: string): Promise<boolean>;

  /** Delete completed operations older than `before`. Returns how many went. */
  purgeCompleted(before: Date): Promise<number>;

  /** Delete idempotency records older than `before`. Returns how many went. */
  purgeIdempotency(before: Date): Promise<number>;
}
