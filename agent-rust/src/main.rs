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

    // Heartbeat loop runs for the life of the process.
    let hb_cfg = cfg.clone();
    let hb_token = device_token.clone();
    let _hb = tokio::spawn(async move {
        if let Err(e) = heartbeat::run_loop(hb_cfg, hb_token).await {
            tracing::error!(error = %e, "heartbeat loop exited");
        }
    });

    // Connect signaling and wait for the backend to start a session.
    let conn = signal::connect_agent(&cfg.ws_base, &device_token)
        .await
        .context("connecting /ws/agent")?;

    let ice = ice_servers_from_env();
    run_session_loop(conn, &cfg, ice, &device_token, "Technician").await
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
    let client = reqwest::Client::new();
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

    run_session_loop(
        conn,
        &cfg,
        join.ice_servers,
        &join.device_token,
        "Technician",
    )
    .await
}

// ---------------------------------------------------------------------------
// shared session loop
// ---------------------------------------------------------------------------
async fn run_session_loop(
    mut conn: SignalConnection,
    cfg: &Config,
    ice: Vec<IceServerConfig>,
    device_token: &str,
    technician_label: &str,
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
                        let mut s = session::Session::new(sid.clone());

                        // MANDATORY banner BEFORE anything becomes active.
                        let handle = banner::show(&sid, technician_label)
                            .context("showing mandatory banner")?;
                        s.mark_banner_shown()?;
                        _banner_handle = Some(handle);

                        // Ack banner visibility so the backend may mark active.
                        conn.tx
                            .send(Envelope::new(
                                EnvelopeType::Banner,
                                sid.clone(),
                                serde_json::json!({ "visible": true }),
                            ))
                            .context("sending banner ack")?;

                        // Only now may the session go active.
                        s.activate()?;

                        // Per-session audit reporter: ships file.transfer,
                        // clipboard.sync, and aggregated input.command_attempt
                        // (counts only) to the backend audit trail.
                        let rep = audit_report::AuditReporter::new(
                            cfg.api_url("/agent/events"),
                            device_token.to_string(),
                            sid.clone(),
                        );
                        let flush_rep = rep.clone();
                        flush_task = Some(tokio::spawn(async move {
                            let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
                            tick.tick().await; // consume immediate first tick
                            loop {
                                tick.tick().await;
                                flush_rep.flush_input();
                            }
                        }));
                        reporter = Some(rep.clone());

                        // Build the peer connection (agent is the offerer).
                        let p = PeerSession::new(
                            sid.clone(),
                            ice.clone(),
                            cfg.downloads_dir.clone(),
                            conn.tx.clone(),
                            Some(rep),
                        )
                        .await
                        .context("building peer connection")?;

                        // TODO: real screen source; interface wired, no fake frames.
                        if let Ok(src) = capture::open_primary_display() {
                            let _ = p.attach_screen_track(src);
                        }

                        let offer = p.create_offer_envelope().await.context("creating offer")?;
                        conn.tx.send(offer).context("sending offer")?;

                        sess = Some(s);
                        peer = Some(p);
                        tracing::info!(%sid, "session active; banner shown and acked");
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
                        if let Some(p) = peer.as_ref() {
                            let _ = p.close().await;
                        }
                        _banner_handle = None;
                        tracing::info!(session_id = %env.session_id, "session ended");
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
