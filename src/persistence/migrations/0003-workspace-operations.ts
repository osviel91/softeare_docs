/**
 * Migration 0003 — the workspace operation journal and idempotency records
 * (Phase 6, mission items 28–32).
 *
 * A project mutation spans two stores that cannot share a transaction: the
 * `resources` row in PostgreSQL and the document's bytes on the project volume.
 * Pretending otherwise is how a move strands a file or a stale write silently
 * wins. This migration adds the two tables that make the split explicit and
 * recoverable:
 *
 * - **`workspace_operations`** is a durable journal. The intended mutation is
 *   committed *with* the row change it describes, before any file is touched, so
 *   a crash at any point leaves a record a recovery pass can finish.
 * - **`idempotency_records`** makes a retried mutation (a proxy replay, an agent
 *   retry after a timeout) execute at most once per `actor + project + key`.
 *
 * ## The one-active-operation invariant
 *
 * `workspace_operations_active_unique` allows at most one *unfinished*
 * operation per resource. That partial unique index is the concurrency control
 * for the filesystem half: the database refuses a second writer's intent while
 * the first writer's file rename is still in flight, so two writers cannot
 * reorder each other's bytes. It works across processes, which is what makes a
 * horizontally scaled deployment correct rather than merely lucky.
 *
 * ## What is deliberately absent
 *
 * No document contents. The journal stores a staging *path* and a content
 * *hash*, never the document text, so the table stays small and no document body
 * leaks into a database dump, a log or an error message.
 */

/** The statements of migration 0003, in order. */
export const up = String.raw`
CREATE TABLE workspace_operations (
  id                 uuid PRIMARY KEY,
  project_id         uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  resource_id        uuid,
  operation          text        NOT NULL,
  status             text        NOT NULL DEFAULT 'pending',
  source_path        text,
  target_path        text,
  staged_path        text,
  content_hash       text,
  expected_revision  integer,
  resulting_revision integer,
  actor_type         text,
  actor_id           text,
  credential_id      uuid,
  request_id         text,
  idempotency_key    text,
  attempts           integer     NOT NULL DEFAULT 0,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  CONSTRAINT workspace_operations_operation_known CHECK (
    operation IN ('create', 'update', 'move', 'delete')
  ),
  CONSTRAINT workspace_operations_status_known CHECK (
    status IN ('pending', 'processing', 'completed', 'failed', 'compensating')
  ),
  CONSTRAINT workspace_operations_attempts_not_negative CHECK (attempts >= 0)
);

CREATE INDEX workspace_operations_project_idx
  ON workspace_operations (project_id, created_at DESC);

CREATE INDEX workspace_operations_unfinished_idx
  ON workspace_operations (status, created_at)
  WHERE status IN ('pending', 'processing', 'compensating');

CREATE UNIQUE INDEX workspace_operations_active_unique
  ON workspace_operations (project_id, resource_id)
  WHERE status IN ('pending', 'processing', 'compensating');

CREATE TABLE idempotency_records (
  actor_id        text        NOT NULL,
  project_id      uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  idempotency_key text        NOT NULL,
  operation       text        NOT NULL,
  status          text        NOT NULL DEFAULT 'in_progress',
  result          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (actor_id, project_id, idempotency_key),
  CONSTRAINT idempotency_records_status_known CHECK (
    status IN ('in_progress', 'completed')
  )
);

CREATE INDEX idempotency_records_created_idx
  ON idempotency_records (created_at);
`;
