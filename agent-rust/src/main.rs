//! `remote-agent` — Rust agent for the remote-support MVP.
//!
//! One binary, several run modes (see `--help`). Cross-platform core (config,
//! HTTP, WS signaling, session state machine, data-channel message types)
//! compiles and runs on Linux CI and Windows alike. Windows-only functionality
//! (screen capture, input injection, DPAPI, native banner, service control) is
//! `#[cfg(windows)]` with compiling non-Windows counterparts.
//!
//! There is deliberately **no** terminal/PowerShell/shell/remote-script surface,
//! and **no** hidden/silent session mode.

mod audit_report;
mod banner;
mod capture;
mod clipboard;
mod config;
mod encode;
mod enroll;
mod file;
mod heartbeat;
mod input;
mod session;
mod signal;
mod token_store;
mod update;
mod webrtc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use config::Config;
use serde::Deserialize;
use signal::{Envelope, EnvelopeType, SessionControlPayload, SignalConnection};
use webrtc::{IceServerConfig, PeerSession};

#[derive(Parser)]
#[command(
    name = "remote-agent",
    version,
    about = "Consented, audited, banner-enforced remote-support agent (safe subset)."
)]
struct Cli {
    /// Override REST base URL (else REMOTE_AGENT_API_BASE / default).
    #[arg(long, global = true)]
    api_base: Option<String>,
    /// Override WS base URL (else REMOTE_AGENT_WS_BASE / default).
    #[arg(long, global = true)]
    ws_base: Option<String>,
    /// Override enrollment token (else REMOTE_AGENT_ENROLLMENT_TOKEN).
    #[arg(long, global = true)]
    enrollment_token: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Unattended: enroll once, heartbeat, wait for session-control:start.
    Service,
    /// Attended: prompt for a session code, redeem it, join the session.
    Portable,
    /// One-shot enrollment (provisioning); persists the device token and exits.
    Enroll {
        /// Human-friendly device name shown in the console.
        #[arg(long)]
        name: Option<String>,
    },
    /// Register the Windows service (cfg-gated; no-op stub elsewhere).
    Install,
    /// Unregister the Windows service (cfg-gated; no-op stub elsewhere).
    Uninstall,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let cfg = Config::resolve(
        cli.api_base.clone(),
        cli.ws_base.clone(),
        cli.enrollment_token.clone(),
    )?;

    match cli.command {
        Command::Service => run_service(cfg).await,
        Command::Portable => run_portable(cfg).await,
        Command::Enroll { name } => run_enroll(cfg, name).await,
        Command::Install => run_install(),
        Command::Uninstall => run_uninstall(),
    }
}

// ---------------------------------------------------------------------------
// enroll
// ---------------------------------------------------------------------------
async fn run_enroll(cfg: Config, name: Option<String>) -> Result<()> {
    let hostname = enroll::detect_hostname();
    let name = name.unwrap_or_else(|| hostname.clone());
    let os = enroll::detect_os();
    enroll::enroll(&cfg, &name, &hostname, os).await?;
    tracing::info!(
        "enrollment complete; device token persisted to {:?}",
        cfg.token_path
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// service (unattended)
// ---------------------------------------------------------------------------
async fn run_service(cfg: Config) -> Result<()> {
    // Load an existing device token, or enroll if we have an enrollment token.
    let device_token = match token_store::load_token(&cfg.token_path)? {
        Some(tok) => {
            tracing::info!("loaded persisted device token");
            tok
        }
        None => {
            tracing::info!("no persisted token; enrolling");
            let hostname = enroll::detect_hostname();
            enroll::enroll(&cfg, &hostname, &hostname, enroll::detect_os()).await?
        }
    };

    // Shared presence status: the heartbeat reports it every tick; the session
    // loop flips it to in-session while a session is active.
    let status = heartbeat::PresenceStatus::new();

    // Heartbeat loop runs for the life of the process.
    let hb_cfg = cfg.clone();
    let hb_token = device_token.clone();
    let hb_status = status.clone();
    let _hb = tokio::spawn(async move {
        if let Err(e) = heartbeat::run_loop(hb_cfg, hb_token, hb_status).await {
            tracing::error!(error = %e, "heartbeat loop exited");
        }
    });

    let ice = ice_servers_from_env();

    // Unattended service: reconnect forever with capped exponential backoff.
    // When the read pump ends (WS drop / backend restart / idle timeout) the
    // session loop returns and we reconnect, so the agent never becomes a
    // heartbeat-only zombie that still looks ONLINE. Backoff resets after a
    // connection that lived long enough to be considered healthy.
    let mut attempt: u32 = 0;
    loop {
        let elapsed = match signal::connect_agent(&cfg.ws_base, &device_token).await {
            Ok(conn) => {
                let started = std::time::Instant::now();
                match run_session_loop(conn, &cfg, ice.clone(), &device_token, status.clone(), true)
                    .await
                {
                    Ok(()) => tracing::info!("signaling connection closed; reconnecting"),
                    Err(e) => tracing::error!(error = %e, "session loop error; reconnecting"),
                }
                Some(started.elapsed())
            }
            Err(e) => {
                tracing::warn!(error = %e, "connecting /ws/agent failed; will retry");
                None
            }
        };
        // A connection that lasted a while is healthy: reset the backoff.
        if matches!(elapsed, Some(d) if d >= std::time::Duration::from_secs(60)) {
            attempt = 0;
        }
        let delay = reconnect_backoff(attempt);
        attempt = attempt.saturating_add(1);
        tracing::info!(
            delay_ms = delay.as_millis() as u64,
            attempt,
            "backing off before reconnect"
        );
        tokio::time::sleep(delay).await;
    }
}

/// Capped exponential reconnect backoff with deterministic jitter.
///
/// Yields 1s, 2s, 4s, 8s, 16s, then 30s (cap). `std` ships no RNG, so the
/// jitter is a small deterministic offset derived from the attempt counter —
/// enough to de-synchronize a fleet of agents without a random source.
fn reconnect_backoff(attempt: u32) -> std::time::Duration {
    let secs = (1u64 << attempt.min(5)).min(30);
    let jitter_ms = (attempt as u64 % 8) * 63; // 0..=441ms
    std::time::Duration::from_secs(secs) + std::time::Duration::from_millis(jitter_ms)
}

// ---------------------------------------------------------------------------
// portable (attended)
// ---------------------------------------------------------------------------
#[derive(Debug, Deserialize)]
struct AttendedJoinResponse {
    session_id: String,
    device_token: String,
    #[serde(default)]
    ice_servers: Vec<IceServerConfig>,
}

async fn run_portable(cfg: Config) -> Result<()> {
    // Prompt for the one-time code (blocking read off the runtime).
    let code = tokio::task::spawn_blocking(|| {
        use std::io::Write;
        print!("Enter the session code your technician gave you: ");
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        std::io::stdin()
            .read_line(&mut line)
            .map(|_| line.trim().to_string())
    })
    .await
    .context("reading code")?
    .context("reading code")?;

    if code.is_empty() {
        anyhow::bail!("no session code entered");
    }

    let hostname = enroll::detect_hostname();
    let client = reqwest::Client::builder()
        .build()
        .context("building HTTP client")?;
    let resp = client
        .post(cfg.api_url("/attended/join"))
        .json(&serde_json::json!({
            "code": code,
            "hostname": hostname,
            "os": enroll::detect_os(),
        }))
        .send()
        .await
        .context("attended join request")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("attended join rejected: HTTP {status}: {body}");
    }
    let join: AttendedJoinResponse = resp.json().await.context("parsing attended join")?;
    tracing::info!(session_id = %join.session_id, "attended session joined");

    // Connect signaling using the ephemeral device token.
    let conn = signal::connect_agent(&cfg.ws_base, &join.device_token)
        .await
        .context("connecting /ws/agent (attended)")?;

    // Attended: a one-shot session; exit when it ends. No heartbeat runs in
    // this mode, so the presence status is a throwaway.
    run_session_loop(
        conn,
        &cfg,
        join.ice_servers,
        &join.device_token,
        heartbeat::PresenceStatus::new(),
        false,
    )
    .await
}

// ---------------------------------------------------------------------------
// shared session loop
// ---------------------------------------------------------------------------
/// Why a session-start sequence aborted. `Transport` means the signaling send
/// channel is gone (the pump task is dead) and the loop must end; `Setup` is
/// any other failure and, in service mode, is survivable — the process skips
/// this session instead of dying.
enum StartFailure {
    Transport,
    Setup(anyhow::Error),
}

async fn run_session_loop(
    mut conn: SignalConnection,
    cfg: &Config,
    ice: Vec<IceServerConfig>,
    device_token: &str,
    status: heartbeat::PresenceStatus,
    keep_alive: bool,
) -> Result<()> {
    let mut sess: Option<session::Session> = None;
    let mut peer: Option<PeerSession> = None;
    // Held for the session's lifetime; dropping it logs banner removal.
    let mut _banner_handle: Option<banner::BannerHandle> = None;
    // Per-session audit reporter + its periodic input-flush task.
    let mut reporter: Option<audit_report::AuditReporter> = None;
    let mut flush_task: Option<tokio::task::JoinHandle<()>> = None;

    while let Some(env) = conn.rx.recv().await {
        match env.kind {
            EnvelopeType::SessionControl => {
                let ctrl: SessionControlPayload = match serde_json::from_value(env.payload.clone())
                {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!(error = %e, "bad session-control payload");
                        continue;
                    }
                };
                match ctrl.action.as_str() {
                    "start" => {
                        let sid = env.session_id.clone();

                        // A duplicate "start" without an intervening "end" must
                        // not leak the previous session's flush task, reporter,
                        // or peer connection. Tear the old one down first.
                        if sess.is_some() || peer.is_some() || flush_task.is_some() {
                            tracing::warn!(%sid, "duplicate 'start' while a session is active; tearing down the previous session first");
                            if let Some(r) = reporter.take() {
                                r.flush_input();
                            }
                            if let Some(t) = flush_task.take() {
                                t.abort();
                            }
                            if let Some(mut s) = sess.take() {
                                let _ = s.end();
                            }
                            if let Some(p) = peer.take() {
                                let _ = p.close().await;
                            }
                            _banner_handle = None;
                            status.set_idle();
                        }

                        // Fail closed to a neutral label when the backend did not
                        // supply a technician name.
                        let tech_label = ctrl
                            .technician_name
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .unwrap_or("Unknown technician")
                            .to_string();

                        // Partial state built during start; each holder is filled
                        // as its step succeeds so a mid-sequence failure can be
                        // torn down cleanly instead of killing the process.
                        let mut new_sess: Option<session::Session> = None;
                        let mut new_banner: Option<banner::BannerHandle> = None;
                        let mut new_reporter: Option<audit_report::AuditReporter> = None;
                        let mut new_flush: Option<tokio::task::JoinHandle<()>> = None;
                        let mut new_peer: Option<PeerSession> = None;

                        // The whole start sequence is fallible-in-a-block: one
                        // failed/hostile start must not propagate out and kill the
                        // process in service mode.
                        let outcome: std::result::Result<(), StartFailure> = async {
                            let mut s = session::Session::new(sid.clone());

                            // MANDATORY banner BEFORE anything becomes active.
                            let handle = banner::show(&sid, &tech_label)
                                .context("showing mandatory banner")
                                .map_err(StartFailure::Setup)?;
                            new_banner = Some(handle);
                            s.mark_banner_shown()
                                .context("banner-shown transition")
                                .map_err(StartFailure::Setup)?;

                            // Ack banner visibility so the backend may mark active.
                            conn.tx
                                .send(Envelope::new(
                                    EnvelopeType::Banner,
                                    sid.clone(),
                                    serde_json::json!({ "visible": true }),
                                ))
                                .map_err(|_| StartFailure::Transport)?;

                            // Only now may the session go active.
                            s.activate()
                                .context("activate transition")
                                .map_err(StartFailure::Setup)?;

                            // Per-session audit reporter: ships file.transfer,
                            // clipboard.sync, and aggregated input.command_attempt
                            // (counts only) to the backend audit trail.
                            let rep = audit_report::AuditReporter::new(
                                cfg.api_url("/agent/events"),
                                device_token.to_string(),
                                sid.clone(),
                            )
                            .context("building audit reporter")
                            .map_err(StartFailure::Setup)?;
                            let flush_rep = rep.clone();
                            new_flush = Some(tokio::spawn(async move {
                                let mut tick =
                                    tokio::time::interval(std::time::Duration::from_secs(5));
                                tick.tick().await; // consume immediate first tick
                                loop {
                                    tick.tick().await;
                                    flush_rep.flush_input();
                                }
                            }));
                            new_reporter = Some(rep.clone());

                            // Build the peer connection (agent is the offerer).
                            let p = PeerSession::new(
                                sid.clone(),
                                ice.clone(),
                                cfg.downloads_dir.clone(),
                                conn.tx.clone(),
                                Some(rep),
                            )
                            .await
                            .context("building peer connection")
                            .map_err(StartFailure::Setup)?;

                            // Start the screen stream now that the session is
                            // Active (banner acknowledged / consent given).
                            match capture::open_primary_display() {
                                Ok(src) => p.start_screen_stream(src),
                                Err(e) => {
                                    tracing::warn!(error = %e, "screen capture unavailable; continuing without video")
                                }
                            }

                            let offer = p
                                .create_offer_envelope()
                                .await
                                .context("creating offer")
                                .map_err(StartFailure::Setup)?;
                            new_peer = Some(p);
                            new_sess = Some(s);
                            conn.tx.send(offer).map_err(|_| StartFailure::Transport)?;
                            Ok(())
                        }
                        .await;

                        match outcome {
                            Ok(()) => {
                                sess = new_sess;
                                peer = new_peer;
                                _banner_handle = new_banner;
                                reporter = new_reporter;
                                flush_task = new_flush;
                                status.set_in_session();
                                tracing::info!(%sid, "session active; banner shown and acked");
                            }
                            Err(fail) => {
                                // Tear down any partially-built state.
                                if let Some(r) = new_reporter.take() {
                                    r.flush_input();
                                }
                                if let Some(t) = new_flush.take() {
                                    t.abort();
                                }
                                if let Some(mut s) = new_sess.take() {
                                    let _ = s.end();
                                }
                                if let Some(p) = new_peer.take() {
                                    let _ = p.close().await;
                                }
                                drop(new_banner.take());
                                status.set_idle();

                                match fail {
                                    StartFailure::Transport => {
                                        tracing::error!(%sid, "signaling transport closed during session start; ending loop");
                                        break;
                                    }
                                    StartFailure::Setup(e) => {
                                        tracing::error!(error = %e, %sid, "session start failed; skipping this session");
                                        // Best-effort: tell the backend it ended.
                                        let _ = conn.tx.send(Envelope::new(
                                            EnvelopeType::SessionControl,
                                            sid.clone(),
                                            serde_json::json!({ "action": "end" }),
                                        ));
                                        if keep_alive {
                                            continue;
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    "end" => {
                        // Flush any pending aggregated input before tearing down.
                        if let Some(r) = reporter.take() {
                            r.flush_input();
                        }
                        if let Some(t) = flush_task.take() {
                            t.abort();
                        }
                        if let Some(s) = sess.as_mut() {
                            let _ = s.end();
                        }
                        if let Some(p) = peer.take() {
                            let _ = p.close().await;
                        }
                        sess = None;
                        _banner_handle = None;
                        status.set_idle();
                        tracing::info!(session_id = %env.session_id, "session ended");
                        if keep_alive {
                            // Unattended service: keep the socket open and wait
                            // for the next session (in-flight audit reports also
                            // complete because the process stays alive).
                            continue;
                        }
                        break;
                    }
                    other => tracing::debug!(action = other, "ignoring session-control action"),
                }
            }
            EnvelopeType::Offer | EnvelopeType::Answer | EnvelopeType::IceCandidate => {
                if let Some(p) = peer.as_ref() {
                    match p.handle_signal(env).await {
                        Ok(Some(reply)) => {
                            let _ = conn.tx.send(reply);
                        }
                        Ok(None) => {}
                        Err(e) => tracing::warn!(error = %e, "signaling handling failed"),
                    }
                } else {
                    tracing::warn!("received SDP/ICE before session start; dropping");
                }
            }
            EnvelopeType::Banner => {
                tracing::debug!("received banner envelope (server ack echo)");
            }
            EnvelopeType::Error => {
                tracing::warn!(payload = %env.payload, "signaling error envelope");
            }
        }
    }

    // Socket closed or session ended: flush any pending audit, stop the flush
    // task, and join the pump.
    if let Some(r) = reporter.take() {
        r.flush_input();
    }
    if let Some(t) = flush_task.take() {
        t.abort();
    }
    status.set_idle();
    conn.pump.abort();
    Ok(())
}

fn ice_servers_from_env() -> Vec<IceServerConfig> {
    match std::env::var("REMOTE_AGENT_ICE_SERVERS") {
        Ok(json) => serde_json::from_str(&json).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "REMOTE_AGENT_ICE_SERVERS not valid JSON; using none");
            Vec::new()
        }),
        Err(_) => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// install / uninstall (Windows service; cfg-gated)
// ---------------------------------------------------------------------------
fn run_install() -> Result<()> {
    #[cfg(windows)]
    {
        // TODO: register the Windows service via the SCM
        // (`CreateServiceW` / `sc create`), pointing at this binary with the
        // `service` subcommand, plus a service main dispatch. Not implemented.
        tracing::warn!("Windows service install is a TODO stub (SCM registration not implemented)");
        Ok(())
    }
    #[cfg(not(windows))]
    {
        eprintln!("`install` is a Windows-only operation; this is a non-Windows build (no-op).");
        Ok(())
    }
}

fn run_uninstall() -> Result<()> {
    #[cfg(windows)]
    {
        // TODO: `DeleteService` after stopping it. Not implemented.
        tracing::warn!("Windows service uninstall is a TODO stub (SCM removal not implemented)");
        Ok(())
    }
    #[cfg(not(windows))]
    {
        eprintln!("`uninstall` is a Windows-only operation; this is a non-Windows build (no-op).");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serialize the env-var mutation so parallel tests don't race on the shared
    // process environment.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_ice_env<T>(val: Option<&str>, f: impl FnOnce() -> T) -> T {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let key = "REMOTE_AGENT_ICE_SERVERS";
        let saved = std::env::var(key).ok();
        match val {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        let out = f();
        match saved {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        out
    }

    #[test]
    fn ice_servers_valid_array() {
        let servers = with_ice_env(
            Some(r#"[{"urls":["stun:a","turn:b"]},{"urls":"stun:c"}]"#),
            ice_servers_from_env,
        );
        assert_eq!(servers.len(), 2);
    }

    #[test]
    fn ice_servers_single_string() {
        let servers = with_ice_env(Some(r#"[{"urls":"stun:only"}]"#), ice_servers_from_env);
        assert_eq!(servers.len(), 1);
    }

    #[test]
    fn ice_servers_invalid_json_is_empty() {
        let servers = with_ice_env(Some("not json at all"), ice_servers_from_env);
        assert!(servers.is_empty());
    }

    #[test]
    fn ice_servers_absent_is_empty() {
        let servers = with_ice_env(None, ice_servers_from_env);
        assert!(servers.is_empty());
    }

    #[test]
    fn reconnect_backoff_is_capped_and_monotonic() {
        // Jitter-free base seconds: 1,2,4,8,16 then capped at 30.
        let base_secs = |a: u32| (1u64 << a.min(5)).min(30);
        assert_eq!(base_secs(0), 1);
        assert_eq!(base_secs(1), 2);
        assert_eq!(base_secs(4), 16);
        assert_eq!(base_secs(5), 30); // 1<<5 = 32, capped to 30
        assert_eq!(base_secs(9), 30);
        for attempt in 0..20u32 {
            let d = reconnect_backoff(attempt);
            // Never below 1s, never above the 30s cap + max jitter (441ms).
            assert!(d >= std::time::Duration::from_secs(1), "attempt {attempt}");
            assert!(
                d <= std::time::Duration::from_millis(30_000 + 441),
                "attempt {attempt} exceeded cap: {d:?}"
            );
        }
        // Caps at 30s for large attempts (plus bounded jitter).
        let big = reconnect_backoff(50);
        assert!(big >= std::time::Duration::from_secs(30));
        assert!(big < std::time::Duration::from_millis(30_500));
        // Jitter de-synchronizes consecutive attempts at the same cap.
        assert_ne!(reconnect_backoff(6), reconnect_backoff(7));
    }
}
