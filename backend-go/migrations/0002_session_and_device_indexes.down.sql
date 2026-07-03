-- 0002_session_and_device_indexes.down.sql — drop what 0002 created.

DROP INDEX IF EXISTS idx_devices_mode_created_at;
DROP INDEX IF EXISTS ux_sessions_open_device;
