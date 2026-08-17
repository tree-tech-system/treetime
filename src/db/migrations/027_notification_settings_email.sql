-- Adds an "also by email" dimension alongside each existing in-app toggle.
-- Defaults to FALSE (opt-in) since email is more intrusive than the in-app
-- bell, unlike the in-app columns which mostly default to TRUE.
ALTER TABLE company_notification_settings ADD COLUMN IF NOT EXISTS quota80_email_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE company_notification_settings ADD COLUMN IF NOT EXISTS quota80_email_employee BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE company_notification_settings ADD COLUMN IF NOT EXISTS edit_request_email_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE company_notification_settings ADD COLUMN IF NOT EXISTS support_reply_email_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE company_notification_settings ADD COLUMN IF NOT EXISTS support_reply_email_employee BOOLEAN NOT NULL DEFAULT FALSE;
