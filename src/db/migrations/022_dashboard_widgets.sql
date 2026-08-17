CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type        VARCHAR(20) NOT NULL CHECK (type IN ('kpi', 'list')),
  title       VARCHAR(200) NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}',
  position    INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_company ON dashboard_widgets(company_id);
