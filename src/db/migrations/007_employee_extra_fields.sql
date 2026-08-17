-- Fields the freelancer form already collects but the API didn't persist yet.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS foreign_worker BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_beneficiary VARCHAR(200);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_name VARCHAR(200);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_branch VARCHAR(20);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_account VARCHAR(50);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_tax_id VARCHAR(30);
