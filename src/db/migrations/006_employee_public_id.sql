-- A stable, non-guessable public identifier for each employee record, distinct
-- from the internal serial id. Used to tell apart individual users/sessions in
-- systems where more than one user is present (support, activity attribution).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS public_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_public_id ON employees(public_id);
