-- 0002_session_and_device_indexes.up.sql
-- Enforce at most one open (pending/active) session per device, and add a
-- covering index for the paginated device list.

-- A device may only ever have a single open session. This turns the CreateUnattended
-- TOCTOU window (check-then-insert) into a hard database guarantee: a losing
-- racer's INSERT fails with 23505, which the service maps to a 409 conflict.
-- Attended sessions have device_id = NULL until join (multiple NULLs are allowed),
-- so this does not constrain unjoined attended codes.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_open_device
    ON sessions (device_id)
    WHERE status IN ('pending', 'active');

-- Backs the unattended device list (WHERE mode = 'unattended' ORDER BY created_at DESC).
CREATE INDEX IF NOT EXISTS idx_devices_mode_created_at
    ON devices (mode, created_at DESC);
