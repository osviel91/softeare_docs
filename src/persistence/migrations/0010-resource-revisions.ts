/** Migration 0010: durable immutable snapshots of server resources. */
export const up = String.raw`
CREATE TABLE resource_revisions (
  resource_id uuid NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  revision integer NOT NULL,
  content text NOT NULL,
  type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  authorship jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, revision),
  CONSTRAINT resource_revisions_revision_positive CHECK (revision > 0),
  CONSTRAINT resource_revisions_type_known CHECK (
    type IN ('sequence-diagram', 'event-flow', 'markdown-document')
  )
);

CREATE INDEX resource_revisions_resource_order_idx
  ON resource_revisions (resource_id, revision ASC);
`;
