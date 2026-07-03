//! Chunked file transfer (`file` data channel).
//!
//! Security-critical (`docs/SECURITY_MODEL.md` §6, `docs/API.md`): the
//! peer-supplied file name is sanitized to a **basename only** (no separators,
//! no traversal, no drive/UNC prefixes) and files are written **only** into a
//! fixed downloads directory. A size cap applies. No path from the peer is ever
//! used to locate the write target — only the sanitized basename joined onto the
//! fixed directory. The sanitization here is implemented for real and
//! cross-platform.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Hard cap on a single transferred file (256 MiB).
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// Cap on a single decoded chunk (4 MiB) to bound memory per message.
pub const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// Wire messages for the `file` channel. Variant names mirror the wire `t`
/// values (`file-offer`, `file-accept`, ...), so the shared prefix is intended.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "kebab-case")]
#[allow(clippy::enum_variant_names)]
pub enum FileMessage {
    FileOffer {
        id: String,
        name: String,
        size: u64,
        direction: String,
    },
    FileAccept {
        id: String,
    },
    FileChunk {
        id: String,
        seq: u64,
        /// base64-encoded bytes.
        data: String,
    },
    FileComplete {
        id: String,
    },
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FileError {
    #[error("file name sanitized to empty / invalid: {0:?}")]
    InvalidName(String),
    #[error("offered size {0} exceeds cap {1}")]
    TooLarge(u64, u64),
    #[error("chunk exceeds per-message cap")]
    ChunkTooLarge,
    #[error("received bytes exceed offered size")]
    Overflow,
    #[error("chunk arrived out of order: expected {expected}, got {got}")]
    OutOfOrder { expected: u64, got: u64 },
    #[error("no active transfer for id {0}")]
    UnknownTransfer(String),
    #[error("invalid base64 chunk")]
    BadBase64,
}

/// Sanitize a peer-supplied file name down to a safe basename.
///
/// Rules:
///   * take the component after the last `/` or `\` (handles both separators
///     regardless of host OS, so a Windows path from the peer is neutralized on
///     Linux and vice-versa),
///   * strip any Windows drive/`:` prefix,
///   * reject `.`/`..`/empty,
///   * strip NUL and control characters,
///   * cap length.
///
/// Returns the safe basename, or `None` if nothing safe remains.
pub fn sanitize_filename(raw: &str) -> Option<String> {
    // Split on BOTH separators so peer-OS conventions can't smuggle a path.
    let last = raw.rsplit(['/', '\\']).next().unwrap_or(raw);

    // Drop any "C:" style drive/stream prefix by taking the part after ':'.
    let no_drive = last.rsplit(':').next().unwrap_or(last);

    // Remove control chars and NULs; keep it to a single line.
    let cleaned: String = no_drive
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string();

    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return None;
    }
    // Defense in depth: after all of the above there must be no separators left.
    if cleaned.contains('/') || cleaned.contains('\\') {
        return None;
    }

    // Cap length (leave room within typical filesystem limits).
    let capped: String = cleaned.chars().take(200).collect();

    // Reject Windows reserved DOS device names (CON, PRN, AUX, NUL, COM1-9,
    // LPT1-9). These are legal separator-free basenames, but on Windows
    // CreateFileW resolves them to devices regardless of the target directory,
    // escaping the "writes only into downloads dir" guarantee. Rejected on all
    // platforms so received files are portable and the guarantee is uniform.
    if is_windows_reserved_name(&capped) {
        return None;
    }
    Some(capped)
}

/// True if `name`'s stem (portion before the first `.`) is a Windows reserved
/// device name, compared case-insensitively.
fn is_windows_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    let upper = stem.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    // COM1..COM9 and LPT1..LPT9 (COM0/LPT0 are not reserved).
    let b = upper.as_bytes();
    b.len() == 4
        && (upper.starts_with("COM") || upper.starts_with("LPT"))
        && b[3].is_ascii_digit()
        && b[3] != b'0'
}

/// Resolve the safe absolute destination path for a sanitized name inside the
/// downloads dir, and assert it stays within that dir.
pub fn dest_path(downloads_dir: &Path, raw_name: &str) -> Result<PathBuf, FileError> {
    let base =
        sanitize_filename(raw_name).ok_or_else(|| FileError::InvalidName(raw_name.into()))?;
    let candidate = downloads_dir.join(&base);

    // Belt-and-braces: the parent of the candidate must be exactly the
    // downloads dir (no traversal survived).
    match candidate.parent() {
        Some(parent) if parent == downloads_dir => Ok(candidate),
        _ => Err(FileError::InvalidName(raw_name.into())),
    }
}

/// State for one in-progress inbound (`to-agent`) transfer.
struct Inbound {
    dest: PathBuf,
    file: std::fs::File,
    declared_size: u64,
    received: u64,
    next_seq: u64,
}

/// Receives inbound file transfers, one directory, size-capped, sanitized.
pub struct FileReceiver {
    downloads_dir: PathBuf,
    active: HashMap<String, Inbound>,
}

impl FileReceiver {
    pub fn new(downloads_dir: PathBuf) -> Self {
        Self {
            downloads_dir,
            active: HashMap::new(),
        }
    }

    /// Handle a `file-offer`: validate name + size, open the destination file.
    /// Returns the sanitized destination path on acceptance.
    pub fn on_offer(&mut self, id: &str, name: &str, size: u64) -> Result<PathBuf, FileError> {
        if size > MAX_FILE_BYTES {
            return Err(FileError::TooLarge(size, MAX_FILE_BYTES));
        }
        let dest = dest_path(&self.downloads_dir, name)?;
        std::fs::create_dir_all(&self.downloads_dir)
            .map_err(|_| FileError::InvalidName(name.into()))?;
        let file = std::fs::File::create(&dest).map_err(|_| FileError::InvalidName(name.into()))?;
        self.active.insert(
            id.to_string(),
            Inbound {
                dest: dest.clone(),
                file,
                declared_size: size,
                received: 0,
                next_seq: 0,
            },
        );
        tracing::info!(target: "audit.file", %id, path = %dest.display(), size, "file.transfer offer accepted");
        Ok(dest)
    }

    /// Handle a `file-chunk`: decode base64, enforce ordering + size caps, write.
    pub fn on_chunk(&mut self, id: &str, seq: u64, b64: &str) -> Result<(), FileError> {
        let inbound = self
            .active
            .get_mut(id)
            .ok_or_else(|| FileError::UnknownTransfer(id.into()))?;

        if seq != inbound.next_seq {
            return Err(FileError::OutOfOrder {
                expected: inbound.next_seq,
                got: seq,
            });
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|_| FileError::BadBase64)?;
        if bytes.len() > MAX_CHUNK_BYTES {
            return Err(FileError::ChunkTooLarge);
        }
        let new_total = inbound.received + bytes.len() as u64;
        if new_total > inbound.declared_size || new_total > MAX_FILE_BYTES {
            return Err(FileError::Overflow);
        }
        inbound
            .file
            .write_all(&bytes)
            .map_err(|_| FileError::Overflow)?;
        inbound.received = new_total;
        inbound.next_seq += 1;
        Ok(())
    }

    /// Handle `file-complete`: flush + close, return the final path and the
    /// number of bytes written (for the audit record).
    pub fn on_complete(&mut self, id: &str) -> Result<(PathBuf, u64), FileError> {
        let mut inbound = self
            .active
            .remove(id)
            .ok_or_else(|| FileError::UnknownTransfer(id.into()))?;
        inbound.file.flush().map_err(|_| FileError::Overflow)?;
        tracing::info!(target: "audit.file", %id, path = %inbound.dest.display(), bytes = inbound.received, "file.transfer complete");
        Ok((inbound.dest, inbound.received))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_traversal() {
        assert_eq!(sanitize_filename("notes.txt").as_deref(), Some("notes.txt"));
        assert_eq!(
            sanitize_filename("../../etc/passwd").as_deref(),
            Some("passwd")
        );
        assert_eq!(
            sanitize_filename("..\\..\\Windows\\System32\\evil.dll").as_deref(),
            Some("evil.dll")
        );
        assert_eq!(
            sanitize_filename("C:\\Users\\admin\\secret.doc").as_deref(),
            Some("secret.doc")
        );
        assert_eq!(sanitize_filename("/abs/path/x").as_deref(), Some("x"));
    }

    #[test]
    fn rejects_dot_and_empty() {
        assert_eq!(sanitize_filename(".."), None);
        assert_eq!(sanitize_filename("."), None);
        assert_eq!(sanitize_filename(""), None);
        assert_eq!(sanitize_filename("/"), None);
        assert_eq!(sanitize_filename("foo/"), None);
        assert_eq!(sanitize_filename("a/.."), None);
    }

    #[test]
    fn rejects_windows_reserved_names() {
        // Bare reserved names and reserved names with an extension are rejected.
        for n in [
            "CON", "con", "NUL", "nul.txt", "CON.log", "COM1", "lpt9", "AUX", "PRN",
        ] {
            assert_eq!(sanitize_filename(n), None, "expected {n} to be rejected");
        }
        // Non-reserved lookalikes are still accepted.
        assert_eq!(sanitize_filename("COM0").as_deref(), Some("COM0"));
        assert_eq!(sanitize_filename("LPT10").as_deref(), Some("LPT10"));
        assert_eq!(
            sanitize_filename("console.txt").as_deref(),
            Some("console.txt")
        );
        assert_eq!(sanitize_filename("comic.png").as_deref(), Some("comic.png"));
    }

    #[test]
    fn strips_control_chars() {
        assert_eq!(
            sanitize_filename("na\u{0000}me\u{0007}.txt").as_deref(),
            Some("name.txt")
        );
    }

    #[test]
    fn dest_stays_in_downloads_dir() {
        let dir = PathBuf::from("/var/lib/remote-agent/downloads");
        let p = dest_path(&dir, "../../etc/passwd").unwrap();
        assert_eq!(p, dir.join("passwd"));
        assert!(p.starts_with(&dir));
    }

    #[test]
    fn dest_rejects_unusable_name() {
        let dir = PathBuf::from("/var/lib/remote-agent/downloads");
        assert!(dest_path(&dir, "..").is_err());
    }

    #[test]
    fn end_to_end_chunked_write() {
        let dir = std::env::temp_dir().join(format!("remote-agent-file-{}", uuid::Uuid::new_v4()));
        let mut rx = FileReceiver::new(dir.clone());
        rx.on_offer("t1", "../hello.txt", 11).unwrap();
        let c0 = base64::engine::general_purpose::STANDARD.encode(b"hello ");
        let c1 = base64::engine::general_purpose::STANDARD.encode(b"world");
        rx.on_chunk("t1", 0, &c0).unwrap();
        rx.on_chunk("t1", 1, &c1).unwrap();
        let (path, bytes) = rx.on_complete("t1").unwrap();
        assert_eq!(path, dir.join("hello.txt"));
        assert_eq!(bytes, 11);
        assert_eq!(std::fs::read(&path).unwrap(), b"hello world");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_oversize_offer() {
        let dir = std::env::temp_dir().join("remote-agent-file-cap");
        let mut rx = FileReceiver::new(dir);
        assert!(matches!(
            rx.on_offer("t", "big.bin", MAX_FILE_BYTES + 1),
            Err(FileError::TooLarge(..))
        ));
    }

    #[test]
    fn rejects_overflow_chunk() {
        let dir = std::env::temp_dir().join(format!("remote-agent-ovf-{}", uuid::Uuid::new_v4()));
        let mut rx = FileReceiver::new(dir.clone());
        rx.on_offer("t", "x.bin", 3).unwrap();
        let c = base64::engine::general_purpose::STANDARD.encode(b"toolong");
        assert!(matches!(rx.on_chunk("t", 0, &c), Err(FileError::Overflow)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
