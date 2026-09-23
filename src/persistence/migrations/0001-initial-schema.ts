/**
 * Migration 0001 — the initial server schema (ADR-040).
 *
 * Migrations are TypeScript modules carrying their SQL as a raw string rather
 * than loose `.sql` files. Reviewing the SQL is unchanged, and the migration
 * ships inside every bundle for free: a `.sql` file would need a loader in
 * Vite, a copy step in the API build, and a path lookup at runtime, which is
 * three ways for a deploy to run a different schema than the tests did.
 *
 * How it is applied: every statement runs inside one transaction together with
 * the `schema_migrations` insert, so a migration is either fully applied or
 * entirely absent. The runner splits on statement boundaries itself, because a
 * multi-statement simple query cannot take bind parameters.
 */

/** The statements of migration 0001, in order. */
export const up = String.raw`
CREATE TABLE users (
  id               uuid PRIMARY KEY,
  identity_issuer  text        NOT NULL,
  identity_subject text        NOT NULL,
  display_name     text        NOT NULL,
  email            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_identity_unique UNIQUE (identity_issuer, identity_subject)
);

CREATE TABLE projects (
  id         uuid PRIMARY KEY,
  owner_id   uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       text        NOT NULL,
  slug       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT projects_slug_shaped CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE UNIQUE INDEX projects_owner_slug_unique ON projects (owner_id, slug);

CREATE TABLE project_members (
  project_id uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT project_members_role_known CHECK (role IN ('OWNER', 'EDITOR', 'VIEWER'))
);

CREATE INDEX project_members_user_idx ON project_members (user_id);

CREATE TABLE resources (
  id         uuid PRIMARY KEY,
  project_id uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  path       text        NOT NULL,
  type       text        NOT NULL,
  metadata   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  revision   integer     NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resources_path_unique UNIQUE (project_id, path),
  CONSTRAINT resources_revision_positive CHECK (revision > 0),
  CONSTRAINT resources_type_known CHECK (
    type IN ('sequence-diagram', 'event-flow', 'markdown-document')
  ),
  CONSTRAINT resources_path_relative CHECK (
    path NOT LIKE '/%'
    AND path NOT LIKE '%\\%'
    AND path !~ '(^|/)\.\.(/|$)'
    AND path !~ '(^|/)\.(/|$)'
    AND length(path) > 0
  )
);

CREATE INDEX resources_project_idx ON resources (project_id);

CREATE TABLE personal_access_tokens (
  id            uuid PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          text        NOT NULL,
  prefix        text        NOT NULL,
  token_hash    text        NOT NULL,
  scopes        text[]      NOT NULL DEFAULT '{}',
  project_ids   uuid[],
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  CONSTRAINT personal_access_tokens_prefix_unique UNIQUE (prefix),
  CONSTRAINT personal_access_tokens_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE INDEX personal_access_tokens_user_idx ON personal_access_tokens (user_id);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  user_agent   text,
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE audit_events (
  id           uuid PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  auth_type    text        NOT NULL,
  project_id   uuid,
  resource_id  uuid,
  action       text        NOT NULL,
  request_id   text,
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_events_project_time_idx ON audit_events (project_id, occurred_at DESC);
CREATE INDEX audit_events_user_time_idx ON audit_events (user_id, occurred_at DESC);
`;
