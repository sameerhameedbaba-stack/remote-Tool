//! WebRTC peer connection skeleton.
//!
//! Sets up an `RTCPeerConnection`, creates the three labeled data channels
//! (`input`, `clipboard`, `file`), and plumbs offer/answer/ICE to
//! [`crate::signal`]. The data-channel **message handlers are wired for real**:
//! they parse and dispatch to [`crate::input`], [`crate::clipboard`], and
//! [`crate::file`] with full validation.
//!
//! The **screen media track is a TODO stub with a defined interface**
//! ([`crate::capture::ScreenSource`]). We deliberately do **not** fabricate
//! encoded frames.
//!
//! (Extern crate `webrtc` is referenced as `::webrtc` to disambiguate from this
//! module of the same name.)

use crate::audit_report::AuditReporter;
use crate::capture::ScreenSource;
use crate::signal::{Envelope, EnvelopeType};
use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;

use ::webrtc::api::interceptor_registry::register_default_interceptors;
use ::webrtc::api::media_engine::MediaEngine;
use ::webrtc::api::{APIBuilder, API};
use ::webrtc::data_channel::data_channel_message::DataChannelMessage;
use ::webrtc::data_channel::RTCDataChannel;
use ::webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use ::webrtc::ice_transport::ice_server::RTCIceServer;
use ::webrtc::interceptor::registry::Registry;
use ::webrtc::peer_connection::configuration::RTCConfiguration;
use ::webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use ::webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use ::webrtc::peer_connection::RTCPeerConnection;

/// ICE server entry as returned by the backend (`ice_servers` in API.md).
#[derive(Debug, Clone, Deserialize)]
pub struct IceServerConfig {
    #[serde(default)]
    pub urls: IceUrls,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

/// `urls` may be a single string or an array in the wild; accept both.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum IceUrls {
    One(String),
    Many(Vec<String>),
}

impl Default for IceUrls {
    fn default() -> Self {
        IceUrls::Many(Vec::new())
    }
}

impl IceServerConfig {
    fn into_rtc(self) -> RTCIceServer {
        let urls = match self.urls {
            IceUrls::One(u) => vec![u],
            IceUrls::Many(v) => v,
        };
        RTCIceServer {
            urls,
            username: self.username.unwrap_or_default(),
            credential: self.credential.unwrap_or_default(),
            ..Default::default()
        }
    }
}

/// A single peer session: owns the `RTCPeerConnection` and its data channels.
pub struct PeerSession {
    session_id: String,
    pc: Arc<RTCPeerConnection>,
    /// Kept alive for the session; also usable to send agent→tech clipboard/file.
    #[allow(dead_code)]
    channels: DataChannels,
    #[allow(dead_code)]
    file_rx: Arc<Mutex<crate::file::FileReceiver>>,
}

/// Handles to the three labeled channels, held to keep them open. The send
/// direction (agent→tech) is a TODO, so these are not read yet.
#[allow(dead_code)]
struct DataChannels {
    input: Arc<RTCDataChannel>,
    clipboard: Arc<RTCDataChannel>,
    file: Arc<RTCDataChannel>,
}

fn build_api() -> Result<API> {
    let mut media = MediaEngine::default();
    media
        .register_default_codecs()
        .context("registering default codecs")?;
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media)
        .context("registering default interceptors")?;
    Ok(APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build())
}

impl PeerSession {
    /// Create a peer connection, wire ICE forwarding to `out_tx`, create the
    /// three data channels, and attach validated message handlers.
    pub async fn new(
        session_id: String,
        ice_servers: Vec<IceServerConfig>,
        downloads_dir: PathBuf,
        out_tx: UnboundedSender<Envelope>,
        reporter: Option<AuditReporter>,
    ) -> Result<Self> {
        let api = build_api()?;
        let config = RTCConfiguration {
            ice_servers: ice_servers
                .into_iter()
                .map(IceServerConfig::into_rtc)
                .collect(),
            ..Default::default()
        };
        let pc = Arc::new(
            api.new_peer_connection(config)
                .await
                .context("creating peer connection")?,
        );

        // Forward locally-gathered ICE candidates to the peer via signaling.
        {
            let out = out_tx.clone();
            let sid = session_id.clone();
            pc.on_ice_candidate(Box::new(move |cand: Option<RTCIceCandidate>| {
                let out = out.clone();
                let sid = sid.clone();
                Box::pin(async move {
                    if let Some(c) = cand {
                        if let Ok(init) = c.to_json() {
                            if let Ok(val) = serde_json::to_value(init) {
                                let _ =
                                    out.send(Envelope::new(EnvelopeType::IceCandidate, sid, val));
                            }
                        }
                    }
                })
            }));
        }

        pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
            tracing::info!(state = ?s, "peer connection state changed");
            Box::pin(async {})
        }));

        // File transfers land in a fixed, sanitized downloads directory.
        let file_rx = Arc::new(Mutex::new(crate::file::FileReceiver::new(downloads_dir)));

        // Create the three labeled channels (offerer role). If the remote peer
        // creates them instead (answerer role), `on_data_channel` re-attaches
        // the same handlers below.
        let input = pc
            .create_data_channel("input", None)
            .await
            .context("creating input channel")?;
        let clipboard = pc
            .create_data_channel("clipboard", None)
            .await
            .context("creating clipboard channel")?;
        let file = pc
            .create_data_channel("file", None)
            .await
            .context("creating file channel")?;

        attach_input_handler(&input, reporter.clone());
        attach_clipboard_handler(&clipboard, reporter.clone());
        attach_file_handler(&file, file_rx.clone(), reporter.clone());

        // Answerer role: attach handlers to peer-created channels by label.
        {
            let file_rx = file_rx.clone();
            let reporter = reporter.clone();
            pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
                let file_rx = file_rx.clone();
                let reporter = reporter.clone();
                Box::pin(async move {
                    match dc.label() {
                        "input" => attach_input_handler(&dc, reporter),
                        "clipboard" => attach_clipboard_handler(&dc, reporter),
                        "file" => attach_file_handler(&dc, file_rx, reporter),
                        other => tracing::warn!(label = other, "ignoring unknown data channel"),
                    }
                })
            }));
        }

        Ok(Self {
            session_id,
            pc,
            channels: DataChannels {
                input,
                clipboard,
                file,
            },
            file_rx,
        })
    }

    /// Create an SDP offer, set it locally, and return the envelope to send.
    pub async fn create_offer_envelope(&self) -> Result<Envelope> {
        let offer = self.pc.create_offer(None).await.context("create_offer")?;
        self.pc
            .set_local_description(offer.clone())
            .await
            .context("set_local_description(offer)")?;
        let payload = serde_json::to_value(offer).context("serialize offer")?;
        Ok(Envelope::new(
            EnvelopeType::Offer,
            self.session_id.clone(),
            payload,
        ))
    }

    /// Handle an inbound signaling envelope. Returns an envelope to send back
    /// (e.g. an `answer` in response to an `offer`), if any.
    pub async fn handle_signal(&self, env: Envelope) -> Result<Option<Envelope>> {
        match env.kind {
            EnvelopeType::Offer => {
                let desc: RTCSessionDescription =
                    serde_json::from_value(env.payload).context("parse offer sdp")?;
                self.pc
                    .set_remote_description(desc)
                    .await
                    .context("set_remote_description(offer)")?;
                let answer = self.pc.create_answer(None).await.context("create_answer")?;
                self.pc
                    .set_local_description(answer.clone())
                    .await
                    .context("set_local_description(answer)")?;
                let payload = serde_json::to_value(answer).context("serialize answer")?;
                Ok(Some(Envelope::new(
                    EnvelopeType::Answer,
                    self.session_id.clone(),
                    payload,
                )))
            }
            EnvelopeType::Answer => {
                let desc: RTCSessionDescription =
                    serde_json::from_value(env.payload).context("parse answer sdp")?;
                self.pc
                    .set_remote_description(desc)
                    .await
                    .context("set_remote_description(answer)")?;
                Ok(None)
            }
            EnvelopeType::IceCandidate => {
                let init: RTCIceCandidateInit =
                    serde_json::from_value(env.payload).context("parse ice candidate")?;
                self.pc
                    .add_ice_candidate(init)
                    .await
                    .context("add_ice_candidate")?;
                Ok(None)
            }
            other => {
                tracing::debug!(kind = ?other, "webrtc layer ignoring non-SDP envelope");
                Ok(None)
            }
        }
    }

    /// TODO: attach the screen video track fed by a [`ScreenSource`].
    ///
    /// The interface is defined (`ScreenSource::next_frame`) but the encode +
    /// `TrackLocalStaticSample` write loop is **not implemented** — we do not
    /// fabricate encoded frames. When implemented this will: create a video
    /// track with the negotiated codec, `add_track` it to `self.pc`, spawn a
    /// task pulling `source.next_frame()`, encode (H.264/VP8), and
    /// `write_sample`.
    pub fn attach_screen_track(&self, _source: Box<dyn ScreenSource>) -> Result<()> {
        tracing::warn!("attach_screen_track is a TODO stub; no media track added (no fake frames)");
        Ok(())
    }

    /// Access the file receiver (for tests / agent→tech transfers).
    #[allow(dead_code)]
    pub fn file_receiver(&self) -> Arc<Mutex<crate::file::FileReceiver>> {
        self.file_rx.clone()
    }

    /// Close the peer connection.
    pub async fn close(&self) -> Result<()> {
        self.pc.close().await.context("closing peer connection")?;
        Ok(())
    }
}

fn attach_input_handler(dc: &Arc<RTCDataChannel>, reporter: Option<AuditReporter>) {
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let reporter = reporter.clone();
        Box::pin(async move {
            match serde_json::from_slice::<crate::input::InputEvent>(&msg.data) {
                Ok(ev) => match crate::input::apply(&ev) {
                    Ok(()) => {
                        // Count for the aggregated input.command_attempt audit
                        // record; no keystroke content leaves this process.
                        if let Some(r) = &reporter {
                            r.note_input();
                        }
                    }
                    Err(e) => tracing::warn!(error = %e, "rejected input event"),
                },
                Err(e) => tracing::warn!(error = %e, "malformed input message"),
            }
        })
    }));
}

fn attach_clipboard_handler(dc: &Arc<RTCDataChannel>, reporter: Option<AuditReporter>) {
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let reporter = reporter.clone();
        Box::pin(async move {
            match serde_json::from_slice::<crate::clipboard::ClipboardMessage>(&msg.data) {
                Ok(cb) => match crate::clipboard::validate(&cb) {
                    Ok(()) => {
                        tracing::info!(target: "audit.clipboard", "clipboard.sync");
                        if let Some(r) = &reporter {
                            r.report_clipboard(&cb.direction, cb.text.chars().count());
                        }
                        if cb.direction == "to-agent" {
                            if let Err(e) = crate::clipboard::set_local(&cb.text) {
                                tracing::warn!(error = %e, "clipboard set failed");
                            }
                        }
                    }
                    Err(e) => tracing::warn!(error = %e, "rejected clipboard message"),
                },
                Err(e) => tracing::warn!(error = %e, "malformed clipboard message"),
            }
        })
    }));
}

fn attach_file_handler(
    dc: &Arc<RTCDataChannel>,
    file_rx: Arc<Mutex<crate::file::FileReceiver>>,
    reporter: Option<AuditReporter>,
) {
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let file_rx = file_rx.clone();
        let reporter = reporter.clone();
        Box::pin(async move {
            let parsed = match serde_json::from_slice::<crate::file::FileMessage>(&msg.data) {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(error = %e, "malformed file message");
                    return;
                }
            };
            let mut rx = match file_rx.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            use crate::file::FileMessage::*;
            let result = match &parsed {
                FileOffer { id, name, size, .. } => rx.on_offer(id, name, *size).map(|_| ()),
                FileChunk { id, seq, data } => rx.on_chunk(id, *seq, data),
                FileComplete { id } => match rx.on_complete(id) {
                    Ok((path, bytes)) => {
                        // Audit the completed transfer with basename + size only.
                        if let Some(r) = &reporter {
                            let name = path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_string();
                            r.report_file(&name, bytes, "to-agent");
                        }
                        Ok(())
                    }
                    Err(e) => Err(e),
                },
                FileAccept { .. } => Ok(()), // agent-as-sender path (TODO)
            };
            if let Err(e) = result {
                tracing::warn!(error = %e, "file transfer error");
            }
        })
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ice_urls_accepts_string_or_array() {
        let one: IceServerConfig =
            serde_json::from_value(serde_json::json!({ "urls": "stun:coturn:3478" })).unwrap();
        assert!(matches!(one.urls, IceUrls::One(_)));
        let many: IceServerConfig = serde_json::from_value(
            serde_json::json!({ "urls": ["turn:a", "turn:b"], "username": "u", "credential": "c" }),
        )
        .unwrap();
        assert!(matches!(many.urls, IceUrls::Many(v) if v.len() == 2));
    }
}
