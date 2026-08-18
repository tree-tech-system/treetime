-- Google-connected mailboxes that can send platform email via OAuth2, as an
-- alternative sender to the manual smtp_settings row (029). Only the
-- long-lived refresh_token is persisted -- nodemailer's OAuth2 support fetches
-- a fresh short-lived access token itself on every send using
-- GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (see src/lib/mailer.js), so there is
-- no access-token/expiry bookkeeping to get wrong here.
-- No `active` flag: disconnecting an account (DELETE /api/owner/email/accounts/:id)
-- is a hard delete, not a soft-disable, so there's no other state to track.
CREATE TABLE IF NOT EXISTS google_email_accounts (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  refresh_token TEXT NOT NULL,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  connected_by  INTEGER REFERENCES owners(id),
  connected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one default sender among connected Google accounts at any time.
CREATE UNIQUE INDEX IF NOT EXISTS one_default_google_account
  ON google_email_accounts (is_default) WHERE is_default = TRUE;
