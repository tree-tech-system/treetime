-- Discrete width preset for dashboard_widgets, replacing free-drag width_px
-- (kept for height only now): 'quarter' | 'half' | 'three_quarter' | 'full'.
-- NULL = default (quarter for kpi tiles, full for list widgets), so existing
-- rows keep rendering exactly as before this migration.
ALTER TABLE dashboard_widgets ADD COLUMN IF NOT EXISTS size TEXT;
