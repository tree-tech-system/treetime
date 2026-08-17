-- Per-company notification preferences, editable by the admin.
CREATE TABLE IF NOT EXISTS company_notification_settings (
  company_id                    INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  quota80_notify_admin          BOOLEAN NOT NULL DEFAULT TRUE,
  quota80_notify_employee       BOOLEAN NOT NULL DEFAULT FALSE,
  edit_request_notify_admin     BOOLEAN NOT NULL DEFAULT TRUE,
  support_reply_notify_admin    BOOLEAN NOT NULL DEFAULT TRUE,
  support_reply_notify_employee BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
