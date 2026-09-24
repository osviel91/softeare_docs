/** Migration 0012: merge provenance and resulting canonical revision. */
export const up = String.raw`
ALTER TABLE change_proposals
  ADD COLUMN merge_authorship jsonb,
  ADD COLUMN merged_at timestamptz,
  ADD COLUMN merged_revision integer;
`;
