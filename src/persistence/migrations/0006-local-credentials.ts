/** Migration 0006 - local email/password credentials. */
export const up = String.raw`
CREATE TABLE local_credentials (
  user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  email         text NOT NULL,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT local_credentials_email_not_blank CHECK (length(btrim(email)) > 0)
);

CREATE UNIQUE INDEX local_credentials_email_unique ON local_credentials (email);
`;
