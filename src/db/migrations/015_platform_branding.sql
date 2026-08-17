-- Single-row table holding the platform's current logo, editable by TreeTime owners.
-- Used as the favicon/brand mark everywhere (main app, owner panel, public pages).
CREATE TABLE IF NOT EXISTS platform_branding (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  logo_path  TEXT,
  logo_mime  VARCHAR(100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);
