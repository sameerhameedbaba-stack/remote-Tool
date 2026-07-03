//! Data-channel audit reporting.
//!
//! The peer-to-peer data channels (input / clipboard / file) carry actions that
//! `docs/SECURITY_MODEL.md` requires to be audited: `file.transfer`,
//! `clipboard.sync`, and `input.command_attempt`. The agent reports these to the
//! backend's device-authenticated `POST /api/v1/agent/events` endpoint so they
//! land in the durable audit trail alongside the backend's session-lifecycle
//! events.
//!
//! Only **non-content** metadata is ever sent: byte counts, a file's basename +
//! size, a clipboard direction + length, and an aggregated input count. Never
//! keystroke contents, clipboard text, or file contents (the backend also
//! whitelists metadata as defense in depth).
//!
//! Reporting is best-effort and fire-and-forget: an audit POST failure must not
//! interrupt the live session, mirroring the backend's best-effort policy for
//! high-volume data events.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::json;

/// Reports data-channel audit events for a single session.
#[derive(Clone)]
pub struct AuditReporter {
    inner: Arc<Inner>,
}

struct Inner {
    client: reqwest::Client,
    events_url: String,
    device_token: String,
    session_id: String,
    /// Aggregated remote-input actions since the last flush (kept as a count so
    /// no keystroke content is ever recorded).
    input_count: AtomicU64,
}

impl AuditReporter {
    /// Build a reporter targeting `events_url` (the backend `/agent/events`
    /// endpoint) authenticated with `device_token` for `session_id`.
    pub fn new(events_url: String, device_token: String, session_id: String) -> Result<Self> {
        let client = reqwest::Client::builder()
            .build()
            .context("building audit HTTP client")?;
        Ok(Self {
            inner: Arc::new(Inner {
                client,
                events_url,
                device_token,
                session_id,
                input_count: AtomicU64::new(0),
            }),
        })
    }

    /// Fire-and-forget report of a single event with non-content metadata.
    pub fn report(&self, event_type: &str, metadata: serde_json::Value) {
        let inner = self.inner.clone();
        let event_type = event_type.to_string();
        tokio::spawn(async move {
            let res = inner
                .client
                .post(&inner.events_url)
                .bearer_auth(&inner.device_token)
                .json(&json!({
                    "session_id": inner.session_id,
                    "event_type": event_type,
                    "metadata": metadata,
                }))
                .send()
                .await;
            if let Err(e) = res {
                tracing::debug!(error = %e, event_type, "audit event report failed (best-effort)");
            }
        });
    }

    /// Count one accepted remote-input action for later aggregated reporting.
    pub fn note_input(&self) {
        self.inner.input_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Flush the aggregated input counter as one `input.command_attempt` record.
    /// Records only the count and a discriminant — never key codes or modifiers.
    pub fn flush_input(&self) {
        let n = self.inner.input_count.swap(0, Ordering::Relaxed);
        if n > 0 {
            self.report(
                "input.command_attempt",
                json!({ "count": n, "kind": "input" }),
            );
        }
    }

    /// Report a completed file transfer (basename + size only).
    pub fn report_file(&self, name: &str, size: u64, direction: &str) {
        self.report(
            "file.transfer",
            json!({ "name": name, "size": size, "direction": direction }),
        );
    }

    /// Report a clipboard sync (direction + length only, never the text).
    pub fn report_clipboard(&self, direction: &str, length: usize) {
        self.report(
            "clipboard.sync",
            json!({ "direction": direction, "length": length }),
        );
    }
}
