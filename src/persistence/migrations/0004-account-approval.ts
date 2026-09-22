/** Migration 0004 — approval state for every authentication method. */
export const up = String.raw`
ALTER TABLE users
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN platform_admin boolean NOT NULL DEFAULT false;

ALTER TABLE users
  ADD CONSTRAINT users_status_known CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED'));

CREATE INDEX users_status_idx ON users (status);
`;
