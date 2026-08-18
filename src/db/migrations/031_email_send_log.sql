-- Audit trail of every email TreeTime has attempted to send. Written from a
-- single choke point (sendMail()/sendTestEmail() in src/lib/mailer.js) so
-- every category (welcome, password reset, notifications, broadcast, test...)
-- is covered without each call site needing its own logging code.
CREATE TABLE IF NOT EXISTS email_send_log (
  id        SERIAL PRIMARY KEY,
  to_email  TEXT NOT NULL,
  subject   TEXT,
  category  TEXT NOT NULL DEFAULT 'other',
  sender    TEXT,
  status    TEXT NOT NULL, -- sent | failed | skipped
  error     TEXT,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_send_log_sent_at ON email_send_log(sent_at DESC);
