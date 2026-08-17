-- Extend the schema to match the real TreeTime domain: an agency (company) that
-- assigns freelancers (employees) to its own clients (projects), tracks billable
-- cost per entry, lets freelancers link to specific clients, and supports an
-- edit-request workflow for correcting past entries.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS business_type VARCHAR(100);

-- "projects" doubles as the agency's own clients.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS business_name VARCHAR(200);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS use_hours_bank BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS monthly_quota_hours NUMERIC(8,2) DEFAULT 0;

-- Which freelancers may log time against which clients. A client with zero rows
-- here is open to every freelancer in the company (matches the prototype's rule).
CREATE TABLE IF NOT EXISTS project_freelancers (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, employee_id)
);

ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS rate_snapshot NUMERIC(10,2);
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS cost NUMERIC(10,2);

CREATE TABLE IF NOT EXISTS edit_requests (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entry_id     INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  admin_note   TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_edit_requests_company ON edit_requests(company_id);
