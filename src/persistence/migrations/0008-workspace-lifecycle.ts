/** Migration 0008 - workspace ownership and default-workspace protection. */
export const up = String.raw`
ALTER TABLE workspaces
  ADD COLUMN owner_id uuid REFERENCES users (id) ON DELETE CASCADE,
  ADD COLUMN is_default boolean NOT NULL DEFAULT false;

UPDATE workspaces
   SET owner_id = id,
       is_default = true;

ALTER TABLE workspaces ALTER COLUMN owner_id SET NOT NULL;
CREATE INDEX workspaces_owner_idx ON workspaces (owner_id);
CREATE UNIQUE INDEX workspaces_one_default_per_owner
  ON workspaces (owner_id) WHERE is_default;
`;
