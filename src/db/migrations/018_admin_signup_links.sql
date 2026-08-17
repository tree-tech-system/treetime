-- Single-use public links a super-admin generates and sends to a prospective client,
-- letting them open their own new company workspace (as a trial admin) without approval.
-- Mirrors client_intake_links / employee_intake_links, but is created by an owner and
-- is not tied to an existing company_id (the company gets created on submit).
CREATE TABLE IF NOT EXISTS admin_signup_links (
  id                 SERIAL PRIMARY KEY,
  token              VARCHAR(64) NOT NULL UNIQUE,
  note               VARCHAR(200),
  created_by         INTEGER REFERENCES owners(id) ON DELETE SET NULL,
  used               BOOLEAN NOT NULL DEFAULT FALSE,
  used_at            TIMESTAMPTZ,
  created_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
