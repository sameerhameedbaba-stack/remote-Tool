-- 0005_device_owner.up.sql — platform-side device ownership.
--
-- RustDesk's native device-to-group assignment is unreliable, so the platform
-- tracks which technician owns a machine itself: owner_username is the
-- technician's username. The fleet view shows a technician the machines whose
-- owner_username is theirs (or whose RustDesk group matches, as a fallback).

ALTER TABLE device_overrides ADD COLUMN IF NOT EXISTS owner_username TEXT;
