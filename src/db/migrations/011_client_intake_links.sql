-- Single-use public links an admin can generate and send to a prospective client,
-- letting them fill out their own client card without logging in. Self-destructs on use.
CREATE TABLE IF NOT EXISTS client_intake_links (
  id                 SERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token              VARCHAR(64) NOT NULL UNIQUE,
  created_by         INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  used               BOOLEAN NOT NULL DEFAULT FALSE,
  used_at            TIMESTAMPTZ,
  created_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  seen               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intake_links_company ON client_intake_links(company_id);
