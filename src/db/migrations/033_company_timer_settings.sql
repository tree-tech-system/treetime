-- Per-company cap on how many timers one employee may run at the same time, editable
-- by the admin. Was previously a single hardcoded MAX_CONCURRENT_TIMERS = 3 constant in
-- routes/timeEntries.js, applying identically to every company.
CREATE TABLE IF NOT EXISTS company_timer_settings (
  company_id             INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  max_concurrent_timers  INTEGER NOT NULL DEFAULT 3 CHECK (max_concurrent_timers >= 1),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
