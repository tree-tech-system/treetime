-- guide_videos was global-only (owner-managed, one shared library for every company).
-- Nullable company_id lets an admin add their own company's videos alongside the global
-- ones: NULL = global (owner-managed, shown to everyone), set = visible only to that
-- one company. Existing rows are all global, so backfill is a no-op.
ALTER TABLE guide_videos ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_guide_videos_company ON guide_videos(company_id);
