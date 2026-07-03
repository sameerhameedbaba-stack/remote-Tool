//! WebSocket signaling client (`GET /ws/agent`, `GET /ws/signal`).
//!
//! Relays the JSON envelopes defined in `docs/API.md`: `offer`, `answer`,
//! `ice-candidate`, `session-control`, `banner`, `error`. Media and data
//! channels flow peer-to-peer; this socket only carries SDP/ICE/control.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::Message;

/// Envelope `type` discriminant. Matches the wire contract exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnvelopeType {
    Offer,
    Answer,
    IceCandidate,
    SessionControl,
    Banner,
    Error,
}

/// A signaling envelope. `payload` is intentionally a raw JSON value: its shape
/// depends on `type` (SDP for offer/answer, ICE init for ice-candidate, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    #[serde(rename = "type")]
    pub kind: EnvelopeType,
    pub session_id: String,
    pub payload: serde_json::Value,
}

impl Envelope {
    pub fn new(
        kind: EnvelopeType,
        session_id: impl Into<String>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            kind,
            session_id: session_id.into(),
            payload,
        }
    }
}

/// Payload of a `session-control` envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionControlPayload {
    /// `start` | `end` | `approve`.
    pub action: String,
}

/// Payload of a `banner` acknowledgement (agent → server). Provided as a typed
/// helper; the loop constructs the JSON inline, so it may appear unused.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BannerPayload {
    pub visible: bool,
}

/// A live signaling connection: a send handle plus a receive stream.
pub struct SignalConnection {
    /// Send envelopes to the peer via the backend relay.
    pub tx: mpsc::UnboundedSender<Envelope>,
    /// Receive envelopes relayed from the peer / backend.
    pub rx: mpsc::UnboundedReceiver<Envelope>,
    /// The background pump task; awaiting it drives the socket.
    pub pump: tokio::task::JoinHandle<Result<()>>,
}

/// Connect to `/ws/agent` with a device-token bearer credential.
pub async fn connect_agent(ws_base: &str, device_token: &str) -> Result<SignalConnection> {
    let url = format!("{ws_base}/ws/agent");
    connect(&url, Some(device_token)).await
}

/// Connect to `/ws/signal?session_id=...` (used by the technician side; provided
/// for completeness and tests). Auth via `?token=` query is also acceptable per
/// the contract, but here we pass the bearer header.
#[allow(dead_code)]
pub async fn connect_signal(
    ws_base: &str,
    session_id: &str,
    bearer: &str,
) -> Result<SignalConnection> {
    let url = format!("{ws_base}/ws/signal?session_id={session_id}");
    connect(&url, Some(bearer)).await
}

async fn connect(url: &str, bearer: Option<&str>) -> Result<SignalConnection> {
    let mut request = url
        .into_client_request()
        .with_context(|| format!("building ws request for {url}"))?;
    if let Some(tok) = bearer {
        request.headers_mut().insert(
            AUTHORIZATION,
            format!("Bearer {tok}")
                .parse()
                .context("building Authorization header")?,
        );
    }

    let (ws_stream, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .with_context(|| format!("connecting websocket {url}"))?;
    tracing::info!(%url, "signaling connected");

    let (mut sink, mut stream) = ws_stream.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Envelope>();
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Envelope>();

    let pump = tokio::spawn(async move {
        loop {
            tokio::select! {
                // Outbound: application → socket.
                maybe_env = out_rx.recv() => {
                    match maybe_env {
                        Some(env) => {
                            let text = serde_json::to_string(&env)
                                .context("serializing outbound envelope")?;
                            sink.send(Message::Text(text)).await
                                .context("sending on websocket")?;
                        }
                        None => {
                            // Sender dropped: close gracefully.
                            let _ = sink.send(Message::Close(None)).await;
                            return Ok(());
                        }
                    }
                }
                // Inbound: socket → application.
                maybe_msg = stream.next() => {
                    match maybe_msg {
                        Some(Ok(Message::Text(txt))) => {
                            match serde_json::from_str::<Envelope>(&txt) {
                                Ok(env) => {
                                    if in_tx.send(env).is_err() {
                                        return Ok(());
                                    }
                                }
                                Err(e) => tracing::warn!(error = %e, "dropping malformed envelope"),
                            }
                        }
                        Some(Ok(Message::Ping(p))) => {
                            let _ = sink.send(Message::Pong(p)).await;
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            tracing::info!("signaling socket closed");
                            return Ok(());
                        }
                        Some(Ok(_)) => { /* ignore binary/pong */ }
                        Some(Err(e)) => {
                            return Err(anyhow::anyhow!("websocket error: {e}"));
                        }
                    }
                }
            }
        }
    });

    Ok(SignalConnection {
        tx: out_tx,
        rx: in_rx,
        pump,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trips() {
        let env = Envelope::new(
            EnvelopeType::SessionControl,
            "sess-1",
            serde_json::json!({ "action": "start" }),
        );
        let wire = serde_json::to_string(&env).unwrap();
        assert!(wire.contains("\"type\":\"session-control\""));
        let back: Envelope = serde_json::from_str(&wire).unwrap();
        assert_eq!(back.kind, EnvelopeType::SessionControl);
        assert_eq!(back.session_id, "sess-1");
        let ctrl: SessionControlPayload = serde_json::from_value(back.payload).unwrap();
        assert_eq!(ctrl.action, "start");
    }

    #[test]
    fn ice_candidate_kind_uses_kebab_case() {
        let env = Envelope::new(EnvelopeType::IceCandidate, "s", serde_json::json!({}));
        let wire = serde_json::to_string(&env).unwrap();
        assert!(wire.contains("\"type\":\"ice-candidate\""));
    }

    #[test]
    fn banner_payload_round_trips() {
        let p = BannerPayload { visible: true };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v, serde_json::json!({ "visible": true }));
    }
}
