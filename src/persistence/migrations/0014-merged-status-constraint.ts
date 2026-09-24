/** Migration 0014: allow the terminal merged proposal state. */
export const up = String.raw`
ALTER TABLE change_proposals
  DROP CONSTRAINT IF EXISTS change_proposals_status_known;
ALTER TABLE change_proposals
  ADD CONSTRAINT change_proposals_status_known
  CHECK (status IN ('draft', 'open', 'closed', 'merged'));
`;
