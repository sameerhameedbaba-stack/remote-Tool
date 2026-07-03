//! Device enrollment (`POST /api/v1/agent/enroll`).
//!
//! Enrollment is gated by the shared enrollment token and returns a device
//! token exactly once. We immediately persist it via [`crate::token_store`].

use crate::config::Config;
use crate::token_store;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
struct EnrollRequest<'a> {
    enrollment_token: &'a str,
    name: &'a str,
    hostname: &'a str,
    os: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct EnrollResponse {
    pub device_id: String,
    pub device_token: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub poll_interval_seconds: Option<u64>,
}

/// Enroll this machine as an unattended device and persist the device token.
///
/// Returns the persisted device token so the caller can proceed directly into
/// the heartbeat/signaling loop without re-reading it.
pub async fn enroll(cfg: &Config, name: &str, hostname: &str, os: &str) -> Result<String> {
    let token = cfg
        .enrollment_token
        .as_deref()
        .context("enrollment token not set (REMOTE_AGENT_ENROLLMENT_TOKEN)")?;

    let client = reqwest::Client::new();
    let req = EnrollRequest {
        enrollment_token: token,
        name,
        hostname,
        os,
    };

    let resp = client
        .post(cfg.api_url("/agent/enroll"))
        .json(&req)
        .send()
        .await
        .context("enroll request failed")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("enroll rejected: HTTP {status}: {body}");
    }

    let parsed: EnrollResponse = resp.json().await.context("parsing enroll response")?;
    token_store::store_token(&cfg.token_path, &parsed.device_token)
        .context("persisting device token")?;

    tracing::info!(device_id = %parsed.device_id, "enrolled and persisted device token");
    Ok(parsed.device_token)
}

/// Best-effort hostname for enrollment metadata.
pub fn detect_hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown-host".to_string())
}

/// OS label reported at enrollment.
pub fn detect_os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}
