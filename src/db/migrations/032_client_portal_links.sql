-- A persistent, reusable public link per client ("project") that mirrors their
-- own client card (info, quota usage, tasks, time entries) for the admin to
-- send them. Unlike client_intake_links this is NOT single-use: it stays valid
-- as long as the client stays active. There's no separate "revoked" flag --
-- the public endpoint simply checks projects.archived = FALSE at read time, so
-- archiving the client instantly and automatically invalidates the link.
CREATE TABLE IF NOT EXISTS client_portal_links (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id     INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  token          VARCHAR(64) NOT NULL UNIQUE,
  created_by     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  last_viewed_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_portal_links_company ON client_portal_links(company_id);
