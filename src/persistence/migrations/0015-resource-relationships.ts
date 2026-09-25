/** Migration 0015: semantic relationships between resources. */
export const up = String.raw`
CREATE TABLE resource_relationships (
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  kind text NOT NULL,
  source_role text,
  target_role text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, source_id, target_id),
  CONSTRAINT resource_relationships_not_self CHECK (source_id <> target_id),
  CONSTRAINT resource_relationships_kind_known CHECK (kind IN ('complementary-view')),
  CONSTRAINT resource_relationships_roles_known CHECK (
    (source_role IS NULL OR source_role IN ('execution', 'causal', 'other')) AND
    (target_role IS NULL OR target_role IN ('execution', 'causal', 'other'))
  )
);
CREATE INDEX resource_relationships_target_idx ON resource_relationships (project_id, target_id);
`;
