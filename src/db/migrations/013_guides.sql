-- Global "how to use the system" video guides, managed by TreeTime staff (owners) and
-- shown to every company's admins/employees. Not scoped by company — one shared library.
CREATE TABLE IF NOT EXISTS guide_categories (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(200) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guide_videos (
  id          SERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES guide_categories(id) ON DELETE CASCADE,
  title       VARCHAR(300) NOT NULL,
  description TEXT,
  youtube_url TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guide_videos_category ON guide_videos(category_id);
