//! Screen-frame encoding + data-channel chunking.
//!
//! A captured BGRA [`RawFrame`](crate::capture::RawFrame) is JPEG-encoded (pure
//! Rust, no C deps) and split into fixed-size binary chunks small enough for a
//! WebRTC data channel. The console reassembles chunks by `frame_id` and decodes
//! the JPEG onto a canvas. This whole module is platform-independent and
//! unit-tested on the Linux host.

use crate::capture::RawFrame;
use anyhow::{Context, Result};
use jpeg_encoder::{ColorType, Encoder};

/// Per-chunk binary header, little-endian, prepended to each chunk payload:
///
/// ```text
/// offset size field
/// 0      4    frame_id  (u32) — increments per frame
/// 4      2    index     (u16) — 0-based chunk index within the frame
/// 6      2    count     (u16) — total chunks in this frame
/// 8      2    width     (u16) — frame width  in px
/// 10     2    height    (u16) — frame height in px
/// 12     ...  jpeg bytes for this chunk
/// ```
pub const CHUNK_HEADER_LEN: usize = 12;

/// Safe payload size per data-channel message (header + jpeg slice). 16 KiB
/// total stays well under the SCTP/data-channel limits across browsers.
pub const MAX_CHUNK_BYTES: usize = 16 * 1024;

/// JPEG-encode a BGRA frame at the given quality (1..=100).
pub fn encode_jpeg(frame: &RawFrame, quality: u8) -> Result<Vec<u8>> {
    let expected = (frame.width as usize) * (frame.height as usize) * 4;
    if frame.bgra.len() < expected {
        anyhow::bail!(
            "frame buffer too small: have {}, need {}",
            frame.bgra.len(),
            expected
        );
    }
    let mut out = Vec::new();
    let encoder = Encoder::new(&mut out, quality.clamp(1, 100));
    encoder
        .encode(
            &frame.bgra[..expected],
            frame.width as u16,
            frame.height as u16,
            ColorType::Bgra,
        )
        .context("JPEG encode failed")?;
    Ok(out)
}

/// Split an encoded JPEG frame into wire chunks (see [`CHUNK_HEADER_LEN`]).
pub fn chunk_frame(frame_id: u32, jpeg: &[u8], width: u16, height: u16) -> Vec<Vec<u8>> {
    let payload_cap = MAX_CHUNK_BYTES - CHUNK_HEADER_LEN;
    let count = jpeg.len().div_ceil(payload_cap).max(1);
    let mut chunks = Vec::with_capacity(count);
    for (index, slice) in jpeg.chunks(payload_cap).enumerate() {
        let mut chunk = Vec::with_capacity(CHUNK_HEADER_LEN + slice.len());
        chunk.extend_from_slice(&frame_id.to_le_bytes());
        chunk.extend_from_slice(&(index as u16).to_le_bytes());
        chunk.extend_from_slice(&(count as u16).to_le_bytes());
        chunk.extend_from_slice(&width.to_le_bytes());
        chunk.extend_from_slice(&height.to_le_bytes());
        chunk.extend_from_slice(slice);
        chunks.push(chunk);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_frame(w: u32, h: u32) -> RawFrame {
        RawFrame {
            width: w,
            height: h,
            bgra: vec![120u8; (w * h * 4) as usize],
            timestamp_us: 0,
        }
    }

    #[test]
    fn encodes_valid_jpeg() {
        let jpeg = encode_jpeg(&solid_frame(16, 16), 80).unwrap();
        // JPEG SOI ... EOI markers.
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "missing JPEG SOI");
        assert_eq!(&jpeg[jpeg.len() - 2..], &[0xFF, 0xD9], "missing JPEG EOI");
    }

    #[test]
    fn rejects_undersized_buffer() {
        let mut f = solid_frame(8, 8);
        f.bgra.truncate(10);
        assert!(encode_jpeg(&f, 80).is_err());
    }

    #[test]
    fn chunks_reassemble_in_order() {
        // A payload larger than one chunk so we exercise multi-chunk framing.
        let jpeg: Vec<u8> = (0..(MAX_CHUNK_BYTES * 2 + 500))
            .map(|i| (i % 251) as u8)
            .collect();
        let chunks = chunk_frame(7, &jpeg, 1920, 1080);
        assert_eq!(chunks.len(), 3);

        // Reassemble the way the console will: order by index, strip headers.
        let mut reassembled = vec![Vec::new(); chunks.len()];
        for c in &chunks {
            let frame_id = u32::from_le_bytes(c[0..4].try_into().unwrap());
            let index = u16::from_le_bytes(c[4..6].try_into().unwrap()) as usize;
            let count = u16::from_le_bytes(c[6..8].try_into().unwrap()) as usize;
            let width = u16::from_le_bytes(c[8..10].try_into().unwrap());
            let height = u16::from_le_bytes(c[10..12].try_into().unwrap());
            assert_eq!(frame_id, 7);
            assert_eq!(count, 3);
            assert_eq!((width, height), (1920, 1080));
            reassembled[index] = c[CHUNK_HEADER_LEN..].to_vec();
        }
        let flat: Vec<u8> = reassembled.into_iter().flatten().collect();
        assert_eq!(flat, jpeg);
    }

    #[test]
    fn single_small_frame_is_one_chunk() {
        let chunks = chunk_frame(1, &[1, 2, 3, 4], 640, 480);
        assert_eq!(chunks.len(), 1);
        assert_eq!(&chunks[0][CHUNK_HEADER_LEN..], &[1, 2, 3, 4]);
    }
}
