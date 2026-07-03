//! Agent configuration.
//!
//! All configuration is sourced from environment variables (with sane dev
//! defaults) or overridden by CLI flags. There are **no hardcoded secrets**:
//! the enrollment token and the persisted device token are always supplied at
//! runtime, never compiled in.
//!
//! Env vars (agent-specific, to avoid clashing with the console's
//! `NEXT_PUBLIC_*` browser vars):
//!   * `REMOTE_AGENT_API_BASE`         — REST base URL   (default `http://localhost:8080`)
//!   * `REMOTE_AGENT_WS_BASE`          — WS base URL     (default `ws://localhost:8080`)
//!   * `REMOTE_AGENT_ENROLLMENT_TOKEN` — shared enrollment token (no default)
//!   * `REMOTE_AGENT_TOKEN_PATH`       — where the device token is persisted
//!   * `REMOTE_AGENT_DOWNLOADS_DIR`    — fixed directory for received files

use anyhow::Result;
use std::path::PathBuf;

/// The application version reported in heartbeats and used by the update flow.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

const DEFAULT_API_BASE: &str = "http://localhost:8080";
const DEFAULT_WS_BASE: &str = "ws://localhost:8080";

/// Resolved runtime configuration shared by every run mode.
#[derive(Debug, Clone)]
pub struct Config {
    /// REST base URL, e.g. `http://localhost:8080`.
    pub api_base: String,
    /// WebSocket base URL, e.g. `ws://localhost:8080`.
    pub ws_base: String,
    /// Shared enrollment token; required only for `enroll` / `service` first run.
    pub enrollment_token: Option<String>,
    /// File path where the (DPAPI-protected on Windows) device token is stored.
    pub token_path: PathBuf,
    /// Fixed directory into which peer-offered files may be written.
    pub downloads_dir: PathBuf,
    /// Reported agent version.
    pub app_version: String,
}

impl Config {
    /// Build config from the environment, applying optional CLI overrides.
    pub fn resolve(
        api_base_override: Option<String>,
        ws_base_override: Option<String>,
        enrollment_token_override: Option<String>,
    ) -> Result<Self> {
        let api_base = api_base_override
            .or_else(|| std::env::var("REMOTE_AGENT_API_BASE").ok())
            .unwrap_or_else(|| DEFAULT_API_BASE.to_string());

        let ws_base = ws_base_override
            .or_else(|| std::env::var("REMOTE_AGENT_WS_BASE").ok())
            .unwrap_or_else(|| DEFAULT_WS_BASE.to_string());

        let enrollment_token = enrollment_token_override
            .or_else(|| std::env::var("REMOTE_AGENT_ENROLLMENT_TOKEN").ok())
            .filter(|s| !s.is_empty());

        let token_path = std::env::var("REMOTE_AGENT_TOKEN_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| default_data_dir().join("device_token.bin"));

        let downloads_dir = std::env::var("REMOTE_AGENT_DOWNLOADS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| default_data_dir().join("downloads"));

        Ok(Self {
            api_base: api_base.trim_end_matches('/').to_string(),
            ws_base: ws_base.trim_end_matches('/').to_string(),
            enrollment_token,
            token_path,
            downloads_dir,
            app_version: APP_VERSION.to_string(),
        })
    }

    /// Full REST endpoint URL for a `/api/v1`-prefixed path.
    pub fn api_url(&self, path: &str) -> String {
        format!("{}/api/v1{}", self.api_base, path)
    }
}

/// Per-user data directory for agent state. Kept dependency-free on purpose.
fn default_data_dir() -> PathBuf {
    // Windows: %LOCALAPPDATA%\RemoteAgent ; Unix: $XDG_DATA_HOME or ~/.local/share.
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local).join("RemoteAgent");
        }
    }
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        return PathBuf::from(xdg).join("remote-agent");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".local/share/remote-agent");
    }
    PathBuf::from(".remote-agent")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // The REMOTE_AGENT_* vars are process-global; serialize every test that
    // reads or mutates them so parallel runs don't race.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    const KEYS: &[&str] = &[
        "REMOTE_AGENT_API_BASE",
        "REMOTE_AGENT_WS_BASE",
        "REMOTE_AGENT_ENROLLMENT_TOKEN",
        "REMOTE_AGENT_TOKEN_PATH",
        "REMOTE_AGENT_DOWNLOADS_DIR",
    ];

    /// Run `f` with all `REMOTE_AGENT_*` vars cleared, restoring them after.
    fn with_clean_env<T>(f: impl FnOnce() -> T) -> T {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved: Vec<(&str, Option<String>)> =
            KEYS.iter().map(|k| (*k, std::env::var(k).ok())).collect();
        for k in KEYS {
            std::env::remove_var(k);
        }
        let out = f();
        for (k, v) in saved {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
        out
    }

    #[test]
    fn resolve_precedence_override_env_default() {
        with_clean_env(|| {
            // Env is set but an explicit override wins.
            std::env::set_var("REMOTE_AGENT_API_BASE", "http://from-env:1");
            let c = Config::resolve(Some("http://override:2".into()), None, None).unwrap();
            assert_eq!(c.api_base, "http://override:2");

            // No override: env wins over the compiled default.
            let c2 = Config::resolve(None, None, None).unwrap();
            assert_eq!(c2.api_base, "http://from-env:1");

            // No override, no env: the default is used.
            std::env::remove_var("REMOTE_AGENT_API_BASE");
            let c3 = Config::resolve(None, None, None).unwrap();
            assert_eq!(c3.api_base, DEFAULT_API_BASE);
            assert_eq!(c3.ws_base, DEFAULT_WS_BASE);
        });
    }

    #[test]
    fn resolve_filters_empty_enrollment_token() {
        with_clean_env(|| {
            // Empty override is filtered to None.
            let c = Config::resolve(None, None, Some(String::new())).unwrap();
            assert!(c.enrollment_token.is_none());

            // Empty env value is also filtered to None.
            std::env::set_var("REMOTE_AGENT_ENROLLMENT_TOKEN", "");
            let c2 = Config::resolve(None, None, None).unwrap();
            assert!(c2.enrollment_token.is_none());

            // A non-empty override is preserved.
            let c3 = Config::resolve(None, None, Some("tok-123".into())).unwrap();
            assert_eq!(c3.enrollment_token.as_deref(), Some("tok-123"));
        });
    }

    #[test]
    fn resolve_defaults_and_overrides_paths() {
        with_clean_env(|| {
            // Defaults: derived from the data dir with the expected basenames.
            let c = Config::resolve(None, None, None).unwrap();
            assert!(c.token_path.ends_with("device_token.bin"));
            assert!(c.downloads_dir.ends_with("downloads"));

            // Env vars override the defaults verbatim.
            std::env::set_var("REMOTE_AGENT_TOKEN_PATH", "/custom/tok.bin");
            std::env::set_var("REMOTE_AGENT_DOWNLOADS_DIR", "/custom/dl");
            let c2 = Config::resolve(None, None, None).unwrap();
            assert_eq!(c2.token_path, PathBuf::from("/custom/tok.bin"));
            assert_eq!(c2.downloads_dir, PathBuf::from("/custom/dl"));
        });
    }

    #[test]
    fn api_url_joins_correctly() {
        let cfg = Config {
            api_base: "http://localhost:8080".into(),
            ws_base: "ws://localhost:8080".into(),
            enrollment_token: None,
            token_path: PathBuf::from("/tmp/t"),
            downloads_dir: PathBuf::from("/tmp/d"),
            app_version: "0.1.0".into(),
        };
        assert_eq!(
            cfg.api_url("/agent/enroll"),
            "http://localhost:8080/api/v1/agent/enroll"
        );
    }

    #[test]
    fn trailing_slash_is_trimmed() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let cfg = Config::resolve(
            Some("http://example.com/".into()),
            Some("ws://example.com/".into()),
            None,
        )
        .unwrap();
        assert_eq!(cfg.api_base, "http://example.com");
        assert_eq!(cfg.ws_base, "ws://example.com");
    }
}
