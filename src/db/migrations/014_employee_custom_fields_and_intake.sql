-- Same custom-field system we built for client cards, mirrored for employee cards.
CREATE TABLE IF NOT EXISTS company_employee_fields (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key          VARCHAR(60) NOT NULL,
  label        VARCHAR(200) NOT NULL,
  field_type   VARCHAR(20) NOT NULL, -- text | textarea | url | file | select
  options      JSONB,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, key)
);

CREATE TABLE IF NOT EXISTS employee_field_values (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  field_id     INTEGER NOT NULL REFERENCES company_employee_fields(id) ON DELETE CASCADE,
  value        TEXT,
  file_name    VARCHAR(255),
  file_path    TEXT,
  file_size    INTEGER,
  file_mime    VARCHAR(150),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, field_id)
);

CREATE INDEX IF NOT EXISTS idx_employee_fields_company ON company_employee_fields(company_id);
CREATE INDEX IF NOT EXISTS idx_employee_field_values_employee ON employee_field_values(employee_id);

-- Single-use public link for a prospective employee to open their own account. Self-destructs on use.
CREATE TABLE IF NOT EXISTS employee_intake_links (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token               VARCHAR(64) NOT NULL UNIQUE,
  created_by          INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  used                BOOLEAN NOT NULL DEFAULT FALSE,
  used_at             TIMESTAMPTZ,
  created_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  seen                BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employee_intake_links_company ON employee_intake_links(company_id);
