-- 0003_multitenant.up.sql — multi-tenant platform.
--
-- Each technician is a tenant with a unique `username` that maps to their
-- subdomain (username.<domain>). Role `admin` is the platform super-admin
-- (admin.<domain>) who creates technicians via `created_by`. `active` allows a
-- technician to be disabled without deletion.

ALTER TABLE technicians ADD COLUMN IF NOT EXISTS username   TEXT;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS active     BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES technicians(id);

-- Backfill username for existing rows from the email local-part, sanitized to
-- the subdomain-safe charset [a-z0-9-], so the NOT NULL + UNIQUE below succeed.
UPDATE technicians
SET username = regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9-]', '', 'g')
WHERE username IS NULL OR username = '';

-- Resolve the rare backfill collision by appending a short id fragment.
UPDATE technicians t
SET username = t.username || left(replace(t.id::text, '-', ''), 4)
WHERE EXISTS (
    SELECT 1 FROM technicians o WHERE o.username = t.username AND o.id <> t.id
);

ALTER TABLE technicians ALTER COLUMN username SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_technicians_username ON technicians (username);
CREATE INDEX IF NOT EXISTS idx_technicians_created_by ON technicians (created_by);
