/** Migration 0005 - server workspaces and workspace membership. */
export const up = String.raw`
CREATE TABLE workspaces (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_members_role_known CHECK (role IN ('ADMIN', 'EDITOR', 'VIEWER'))
);

CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

ALTER TABLE projects ADD COLUMN workspace_id uuid REFERENCES workspaces (id) ON DELETE CASCADE;

INSERT INTO workspaces (id, name)
SELECT id, COALESCE(NULLIF(btrim(display_name), ''), 'Personal') || ' Workspace'
FROM users;

INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT id, id, 'ADMIN' FROM users;

UPDATE projects SET workspace_id = owner_id;

ALTER TABLE projects ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX projects_workspace_idx ON projects (workspace_id);
`;
