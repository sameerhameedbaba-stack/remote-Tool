-- 0005_device_owner.down.sql
ALTER TABLE device_overrides DROP COLUMN IF EXISTS owner_username;
