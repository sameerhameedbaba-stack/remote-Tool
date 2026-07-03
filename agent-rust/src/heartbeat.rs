//! Presence heartbeat (`POST /api/v1/agent/heartbeat`).
//!
//! Posts every 15s (the backend presence TTL is 30s). Runs until cancelled.

use crate::config::Config;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Default heartbeat cadence. The backend presence TTL is 30s, so 15s gives a
/// comfortable 2x margin.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Debug, Serialize)]
struct HeartbeatRequest<'a> {
    status: &'a str,
    app_version: &'a str,
}

#[derive(Debug, Deserialize)]
struct HeartbeatResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    presence_ttl_seconds: Option<u64>,
}

/// Send a single heartbeat. Returns `Ok(())` on a 2xx `{"ok":true}`.
pub async fn send_once(
    client: &reqwest::Client,
    cfg: &Config,
    device_token: &str,
    status: &str,
) -> Result<()> {
    let body = HeartbeatRequest {
        status,
        app_version: &cfg.app_version,
    };
    let resp = client
        .post(cfg.api_url("/agent/heartbeat"))
        .bearer_auth(device_token)
        .json(&body)
        .send()
        .await
        .context("heartbeat request failed")?;

    let status_code = resp.status();
    if !status_code.is_success() {
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("heartbeat rejected: HTTP {status_code}: {text}");
    }
    let parsed: HeartbeatResponse = resp.json().await.unwrap_or(HeartbeatResponse {
        ok: true,
        presence_ttl_seconds: None,
    });
    tracing::debug!(ok = parsed.ok, ttl = ?parsed.presence_ttl_seconds, "heartbeat ok");
    Ok(())
}

/// Run the heartbeat loop until the process is stopped or the future is dropped.
///
/// Transient failures are logged and retried on the next tick rather than
/// aborting the loop — a temporary backend blip should not deregister the agent.
pub async fn run_loop(cfg: Config, device_token: String) -> Result<()> {
    let client = reqwest::Client::new();
    let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        if let Err(e) = send_once(&client, &cfg, &device_token, "idle").await {
            tracing::warn!(error = %e, "heartbeat failed; will retry");
        }
    }
}
