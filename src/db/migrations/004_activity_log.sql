CREATE TABLE IF NOT EXISTS api_activity_log (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  api_key_id   INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  method       VARCHAR(10) NOT NULL,
  path         TEXT NOT NULL,
  status_code  INTEGER,
  ip           VARCHAR(64),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_company ON api_activity_log(company_id, created_at DESC);
