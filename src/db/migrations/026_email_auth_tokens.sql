-- Single-use tokens backing both the forgot/reset-password flow and the
-- email-confirmation flow. Stores a hash of the token, never the raw value,
-- same principle as password_hash: a DB leak alone can't be used to reset
-- someone's account.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL, -- 'password_reset' | 'email_confirm'
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMPTZ;
