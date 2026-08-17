-- A running ledger of platform changes (added/changed/removed/fixed), visible to
-- TreeTime owners only. Lets the team track what shipped when, and roll back
-- mentally if something breaks.
CREATE TABLE IF NOT EXISTS system_changelog (
  id           SERIAL PRIMARY KEY,
  version      VARCHAR(20) NOT NULL,
  category     VARCHAR(20) NOT NULL, -- added | changed | removed | fixed
  title        VARCHAR(300) NOT NULL,
  description  TEXT,
  released_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   INTEGER REFERENCES owners(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_changelog_released ON system_changelog(released_at DESC);
