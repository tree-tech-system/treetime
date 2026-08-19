-- Lets a running timer be paused ("frozen") without ending it. paused_at is set while
-- currently paused (NULL otherwise); paused_seconds accumulates the total time spent
-- paused across every pause/resume cycle, finalized into this column on each resume
-- (and on stop, for any pause still in progress at that moment). Cost/duration
-- calculations subtract paused_seconds so paused time is never counted as worked time.
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS paused_seconds INTEGER NOT NULL DEFAULT 0;
