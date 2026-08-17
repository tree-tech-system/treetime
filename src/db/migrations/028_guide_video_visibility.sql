-- Which roles can see a guide video: 'admin' (admin only) or 'all' (admin + employee).
-- Default 'all' preserves today's behavior for existing videos (shown to everyone).
ALTER TABLE guide_videos ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'all';
