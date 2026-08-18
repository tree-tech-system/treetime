-- Singleton row (id always 1) holding the outbound SMTP connection settings,
-- editable from the owner panel instead of only via the server .env. Any field
-- left NULL here falls back to the matching SMTP_* env var at send time
-- (see src/lib/mailer.js getSmtpConfig()) -- this table doesn't have to be
-- fully filled in for existing env-based setups to keep working.
CREATE TABLE IF NOT EXISTS smtp_settings (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  host       TEXT,
  port       INTEGER,
  secure     BOOLEAN NOT NULL DEFAULT FALSE,
  username   TEXT,
  password   TEXT,
  from_name  TEXT,
  from_email TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES owners(id),
  CONSTRAINT smtp_settings_singleton CHECK (id = 1)
);
