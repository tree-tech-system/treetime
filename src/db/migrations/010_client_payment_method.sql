-- How a client is billed: hourly (with their own hourly rate) or hours-bank (existing quota fields).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'hours_bank';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2) DEFAULT 0;
