-- Audit log for admin-initiated "log in as" (impersonation) of an employee within the
-- admin's own company. Mirrors impersonation_log (owner-level, migration 002) but scoped
-- to an admin employee rather than a Tree Tech owner -- separate table since owner_id
-- there is NOT NULL and references owners(id), not employees(id).
CREATE TABLE IF NOT EXISTS employee_impersonation_log (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  admin_id     INTEGER NOT NULL REFERENCES employees(id),
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
