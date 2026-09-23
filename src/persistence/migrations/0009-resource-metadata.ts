/** Migration 0009: semantic metadata belongs to the existing resource row. */
export const up = String.raw`
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
`;
