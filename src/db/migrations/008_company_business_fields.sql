-- Fields collected on the self-service client intake form.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_id VARCHAR(30);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address VARCHAR(255);
