/** Migration 0007 - separate authentication identities from users. */
export const up = String.raw`
CREATE TABLE user_identities (
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  issuer     text        NOT NULL,
  subject    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject)
);

CREATE INDEX user_identities_user_idx ON user_identities (user_id);

INSERT INTO user_identities (user_id, issuer, subject)
SELECT id, identity_issuer, identity_subject FROM users;

ALTER TABLE users
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN activated_by uuid REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE users DROP CONSTRAINT users_identity_unique;
ALTER TABLE users
  DROP COLUMN identity_issuer,
  DROP COLUMN identity_subject;
`;
