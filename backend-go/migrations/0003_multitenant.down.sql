-- 0003_multitenant.down.sql
DROP INDEX IF EXISTS idx_technicians_created_by;
DROP INDEX IF EXISTS idx_technicians_username;
ALTER TABLE technicians DROP COLUMN IF EXISTS created_by;
ALTER TABLE technicians DROP COLUMN IF EXISTS active;
ALTER TABLE technicians DROP COLUMN IF EXISTS username;
