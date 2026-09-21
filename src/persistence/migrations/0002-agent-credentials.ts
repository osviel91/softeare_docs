/**
 * Migration 0002 — agent identities and credentials (ADR-043).
 *
 * Phase 5 originally modelled a Personal Access Token as belonging directly to
 * a user (`personal_access_tokens`). The corrected model inserts an **agent
 * identity** between them:
 *
 * ```
 * User ──owns──► AgentIdentity ──has──► AgentCredential
 * ```
 *
 * so an agent can hold several independently revocable credentials, be disabled
 * as a whole, and be attributed in the audit trail as the actor while its owner
 * remains the subject.
 *
 * Three tables carry that model. `personal_access_tokens` is dropped: its
 * structure has no place for an agent, and the only value it holds is a hash,
 * which cannot be carried across without also inventing an agent per user. No
 * plaintext is recoverable from it in any case, so a credential issued before
 * this migration is re-issued rather than silently reparented.
 *
 * The audit table gains the actor columns the mission requires. `user_id` stays
 * and means the *subject*; `actor_id` is the user id or the agent id, and
 * `credential_id` names the credential an agent authenticated with. They are
 * text/uuid without a foreign key on purpose: an audit row must survive an
 * agent being disabled, and history is not a live reference.
 */

/** The statements of migration 0002, in order. */
export const up = String.raw`
CREATE TABLE agent_identities (
  id            uuid PRIMARY KEY,
  owner_user_id uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          text        NOT NULL,
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz,
  CONSTRAINT agent_identities_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE INDEX agent_identities_owner_idx ON agent_identities (owner_user_id);

CREATE TABLE agent_credentials (
  id           uuid PRIMARY KEY,
  agent_id     uuid        NOT NULL REFERENCES agent_identities (id) ON DELETE CASCADE,
  name         text        NOT NULL,
  token_prefix text        NOT NULL,
  token_hash   text        NOT NULL,
  scopes       text[]      NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  CONSTRAINT agent_credentials_prefix_unique UNIQUE (token_prefix),
  CONSTRAINT agent_credentials_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE INDEX agent_credentials_agent_idx ON agent_credentials (agent_id);

CREATE TABLE agent_credential_projects (
  credential_id uuid NOT NULL REFERENCES agent_credentials (id) ON DELETE CASCADE,
  project_id    uuid NOT NULL,
  PRIMARY KEY (credential_id, project_id)
);

ALTER TABLE audit_events ADD COLUMN actor_type text NOT NULL DEFAULT 'user';

ALTER TABLE audit_events ADD COLUMN actor_id text;

ALTER TABLE audit_events ADD COLUMN credential_id uuid;

DROP TABLE personal_access_tokens;
`;
