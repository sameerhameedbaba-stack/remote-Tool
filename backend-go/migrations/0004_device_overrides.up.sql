-- 0004_device_overrides.up.sql — platform-side rename/hide for RustDesk devices.
--
-- RustDesk's API doesn't support renaming a device alias by token, so the
-- platform keeps its own per-device display name (alias) and a hidden flag
-- (used by "delete from dashboard"), keyed by the RustDesk device id.

CREATE TABLE IF NOT EXISTS device_overrides (
    rustdesk_id TEXT PRIMARY KEY,
    alias       TEXT,
    hidden      BOOLEAN     NOT NULL DEFAULT false,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
