-- Multi-tenant migration: companies (clients paying for TreeTime), owners (TreeTime staff),
-- support tickets, and impersonation audit log.

CREATE TABLE IF NOT EXISTS companies (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(50),
  plan          VARCHAR(50) NOT NULL DEFAULT 'trial',   -- trial | basic | pro | enterprise
  status        VARCHAR(30) NOT NULL DEFAULT 'active',  -- active | suspended | cancelled
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS owners (
  id            SERIAL PRIMARY KEY,
  full_name     VARCHAR(200) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed a default company and attach all existing data to it, so nothing breaks.
INSERT INTO companies (id, name, plan, status)
  VALUES (1, 'TreeTime Demo', 'enterprise', 'active')
  ON CONFLICT (id) DO NOTHING;
SELECT setval('companies_id_seq', GREATEST((SELECT MAX(id) FROM companies), 1));

ALTER TABLE employees   ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE projects    ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE api_keys     ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE webhooks     ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;

UPDATE employees    SET company_id = 1 WHERE company_id IS NULL;
UPDATE projects     SET company_id = 1 WHERE company_id IS NULL;
UPDATE time_entries SET company_id = 1 WHERE company_id IS NULL;
UPDATE api_keys      SET company_id = 1 WHERE company_id IS NULL;
UPDATE webhooks       SET company_id = 1 WHERE company_id IS NULL;

ALTER TABLE employees    ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE projects     ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE time_entries ALTER COLUMN company_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id);
CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_company ON time_entries(company_id);

-- An email is only unique within its company (two different client companies
-- may each have an employee with the same email).
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_company_email ON employees(company_id, email);

CREATE TABLE IF NOT EXISTS support_tickets (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id  INTEGER REFERENCES employees(id) ON DELETE SET NULL, -- who opened it (NULL if owner-initiated)
  subject      VARCHAR(300) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'open',     -- open | pending | closed
  priority     VARCHAR(20) NOT NULL DEFAULT 'normal',   -- low | normal | high | urgent
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id           SERIAL PRIMARY KEY,
  ticket_id    INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_type  VARCHAR(10) NOT NULL, -- 'employee' | 'owner'
  sender_name  VARCHAR(200) NOT NULL,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tickets_company ON support_tickets(company_id);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON support_ticket_messages(ticket_id);

CREATE TABLE IF NOT EXISTS impersonation_log (
  id           SERIAL PRIMARY KEY,
  owner_id     INTEGER NOT NULL REFERENCES owners(id),
  company_id   INTEGER NOT NULL REFERENCES companies(id),
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
