-- Built-in metadata on every client (project) card: who created/last edited it,
-- and a stable technical instance id (Mongo-ObjectId-style hex string).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS instance_id CHAR(24);
UPDATE projects SET instance_id = substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 24) WHERE instance_id IS NULL;
ALTER TABLE projects ALTER COLUMN instance_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_instance_id ON projects(instance_id);

-- Admin-defined custom field definitions, applied to every client card in the company.
CREATE TABLE IF NOT EXISTS company_client_fields (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key          VARCHAR(60) NOT NULL,
  label        VARCHAR(200) NOT NULL,
  field_type   VARCHAR(20) NOT NULL, -- text | textarea | url | file | select
  options      JSONB,                -- for select: array of option strings
  sort_order   INTEGER NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, key)
);

-- One value per (client, field). Text/textarea/url/select use `value`; file uses the file_* columns.
CREATE TABLE IF NOT EXISTS project_field_values (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  field_id     INTEGER NOT NULL REFERENCES company_client_fields(id) ON DELETE CASCADE,
  value        TEXT,
  file_name    VARCHAR(255),
  file_path    TEXT,
  file_size    INTEGER,
  file_mime    VARCHAR(150),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, field_id)
);

CREATE INDEX IF NOT EXISTS idx_client_fields_company ON company_client_fields(company_id);
CREATE INDEX IF NOT EXISTS idx_field_values_project ON project_field_values(project_id);
