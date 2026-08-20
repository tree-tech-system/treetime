-- "Long entry" duration alert: lets an admin be notified whenever a time entry's net
-- worked duration (excluding paused time) is at or above a threshold they configure,
-- e.g. "notify me about any report of 120+ minutes". threshold_minutes NULL = no
-- threshold configured yet -- unlike the other notification types here, this one has
-- no meaningful "on" state until the admin actively sets a number, so the trigger
-- logic must treat NULL as "feature off" regardless of the notify/email flags.
ALTER TABLE company_notification_settings ADD COLUMN IF NOT EXISTS long_entry_threshold_minutes INTEGER;
ALTER TABLE company_notification_settings ADD COLUMN IF NOT EXISTS long_entry_notify_admin BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE company_notification_settings ADD COLUMN IF NOT EXISTS long_entry_email_admin BOOLEAN NOT NULL DEFAULT FALSE;
