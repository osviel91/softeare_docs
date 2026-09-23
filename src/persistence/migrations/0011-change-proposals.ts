/** Migration 0011: isolated candidate resource states. */
export const up = String.raw`
CREATE TABLE change_proposals (
  id                uuid NOT NULL,
  resource_id       uuid NOT NULL,
  base_revision     integer NOT NULL,
  proposed_content  text NOT NULL,
  proposed_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  title             text NOT NULL,
  description       text,
  authorship        jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'draft',
  proposal_version  integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT change_proposals_base_revision_fk
    FOREIGN KEY (resource_id, base_revision)
    REFERENCES resource_revisions (resource_id, revision)
    ON DELETE CASCADE,
  CONSTRAINT change_proposals_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT change_proposals_status_known CHECK (status IN ('draft', 'open', 'closed')),
  CONSTRAINT change_proposals_version_positive CHECK (proposal_version > 0)
);

CREATE INDEX change_proposals_resource_idx
  ON change_proposals (resource_id, created_at DESC);
`;
