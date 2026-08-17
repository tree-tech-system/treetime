-- Unified notification feed for all three permission levels. `scope` decides who
-- can see a row: 'owner' (TreeTime staff, any owner), 'admin' (company admins,
-- matched by company_id), 'employee' (one specific employee, matched by employee_id).
CREATE TABLE IF NOT EXISTS notifications (
  id           SERIAL PRIMARY KEY,
  scope        VARCHAR(20) NOT NULL, -- owner | admin | employee
  company_id   INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  employee_id  INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  type         VARCHAR(50) NOT NULL,
  title        VARCHAR(300) NOT NULL,
  body         TEXT,
  link_page    VARCHAR(50),
  read         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_owner ON notifications(scope) WHERE scope = 'owner';
CREATE INDEX IF NOT EXISTS idx_notifications_admin ON notifications(company_id) WHERE scope = 'admin';
CREATE INDEX IF NOT EXISTS idx_notifications_employee ON notifications(employee_id) WHERE scope = 'employee';
