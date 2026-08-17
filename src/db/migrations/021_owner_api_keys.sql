CREATE TABLE IF NOT EXISTS owner_api_keys (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(200) NOT NULL,
  key_prefix   VARCHAR(12) NOT NULL,
  key_hash     VARCHAR(255) NOT NULL,
  scopes       TEXT[] NOT NULL DEFAULT '{}',   -- changelog:write | impersonate
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   INTEGER NOT NULL REFERENCES owners(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_owner_api_keys_prefix ON owner_api_keys(key_prefix);
