-- TreeTime API schema

CREATE TABLE IF NOT EXISTS employees (
  id            SERIAL PRIMARY KEY,
  full_name     VARCHAR(200) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(30) NOT NULL DEFAULT 'employee', -- employee | manager | admin
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,
  client_name VARCHAR(200),
  color       VARCHAR(20) DEFAULT '#2F6F4E',
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS time_entries (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  description  TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,                -- NULL while timer is running
  source       VARCHAR(30) NOT NULL DEFAULT 'web', -- web | mobile | api | integration:<name>
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_time_entries_employee ON time_entries(employee_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_running ON time_entries(employee_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS api_keys (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,           -- label, e.g. "Payroll system"
  key_prefix  VARCHAR(12) NOT NULL,             -- shown to user, first chars of key
  key_hash    VARCHAR(255) NOT NULL,            -- bcrypt hash of full key
  scopes      TEXT[] NOT NULL DEFAULT '{read}', -- read | write | admin
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS webhooks (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,
  target_url  TEXT NOT NULL,
  secret      VARCHAR(255) NOT NULL,   -- used to sign payloads (HMAC)
  events      TEXT[] NOT NULL,         -- e.g. {time_entry.created, time_entry.stopped}
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           SERIAL PRIMARY KEY,
  webhook_id   INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event        VARCHAR(100) NOT NULL,
  payload      JSONB NOT NULL,
  status_code  INTEGER,
  success      BOOLEAN,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
