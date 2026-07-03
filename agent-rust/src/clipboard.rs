//! Text-only clipboard sync.
//!
//! Contract (`docs/SECURITY_MODEL.md` §6): **text only** — no HTML/RTF/file-list
//! formats. This module validates that constraint on every platform; the actual
//! OS clipboard get/set is cfg-gated and stubbed (Windows interface documented;
//! elsewhere log-only).

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A clipboard message matching the `clipboard` data-channel wire format.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClipboardMessage {
    #[serde(rename = "t")]
    pub t: String,
    /// `to-agent` (set local clipboard) | `to-tech` (read local clipboard).
    pub direction: String,
    pub text: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ClipboardError {
    #[error("unexpected clipboard message type: {0}")]
    BadType(String),
    #[error("unknown clipboard direction: {0}")]
    BadDirection(String),
    #[error("clipboard text exceeds cap of {cap} bytes ({got})")]
    TooLarge { cap: usize, got: usize },
    #[error("clipboard text contains a disallowed control character")]
    ControlChars,
}

/// Cap on a single clipboard payload (1 MiB of UTF-8 text).
pub const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;

/// Validate a clipboard message is well-formed text within limits.
pub fn validate(msg: &ClipboardMessage) -> Result<(), ClipboardError> {
    if msg.t != "clipboard" {
        return Err(ClipboardError::BadType(msg.t.clone()));
    }
    if msg.direction != "to-agent" && msg.direction != "to-tech" {
        return Err(ClipboardError::BadDirection(msg.direction.clone()));
    }
    if msg.text.len() > MAX_CLIPBOARD_BYTES {
        return Err(ClipboardError::TooLarge {
            cap: MAX_CLIPBOARD_BYTES,
            got: msg.text.len(),
        });
    }
    // Text only: reject control chars other than the common whitespace ones.
    if msg
        .text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(ClipboardError::ControlChars);
    }
    Ok(())
}

/// Set the local clipboard from a `to-agent` message (after validation).
pub fn set_local(text: &str) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        // TODO: Open the clipboard (`OpenClipboard`), `EmptyClipboard`, allocate
        // a global `CF_UNICODETEXT` buffer and `SetClipboardData`. Text-only:
        // never register HTML/RTF/`CF_HDROP` formats.
        let _ = text;
        tracing::debug!("clipboard set_local is a TODO stub (Windows)");
        Ok(())
    }
    #[cfg(not(windows))]
    {
        tracing::debug!(
            len = text.len(),
            "clipboard set_local not supported (log-only stub)"
        );
        Ok(())
    }
}

/// Read the local clipboard for a `to-tech` sync (after validation of the
/// request). Returns text only. Wired for the agent→tech direction (TODO).
#[allow(dead_code)]
pub fn get_local() -> anyhow::Result<String> {
    #[cfg(windows)]
    {
        // TODO: `OpenClipboard`, `GetClipboardData(CF_UNICODETEXT)`, copy out the
        // UTF-16 buffer and convert. Only `CF_UNICODETEXT` is read.
        tracing::debug!("clipboard get_local is a TODO stub (Windows)");
        Ok(String::new())
    }
    #[cfg(not(windows))]
    {
        tracing::debug!("clipboard get_local not supported (log-only stub)");
        Ok(String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(dir: &str, text: &str) -> ClipboardMessage {
        ClipboardMessage {
            t: "clipboard".into(),
            direction: dir.into(),
            text: text.into(),
        }
    }

    #[test]
    fn accepts_plain_text() {
        assert!(validate(&msg("to-agent", "hello\nworld\t!")).is_ok());
        assert!(validate(&msg("to-tech", "")).is_ok());
    }

    #[test]
    fn rejects_bad_direction() {
        assert!(matches!(
            validate(&msg("sideways", "x")),
            Err(ClipboardError::BadDirection(_))
        ));
    }

    #[test]
    fn rejects_control_chars() {
        assert!(matches!(
            validate(&msg("to-agent", "bad\u{0007}bell")),
            Err(ClipboardError::ControlChars)
        ));
    }

    #[test]
    fn rejects_oversize() {
        let big = "a".repeat(MAX_CLIPBOARD_BYTES + 1);
        assert!(matches!(
            validate(&msg("to-agent", &big)),
            Err(ClipboardError::TooLarge { .. })
        ));
    }
}
