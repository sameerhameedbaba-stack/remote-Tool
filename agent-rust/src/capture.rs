//! Screen capture interface.
//!
//! This module defines the [`ScreenSource`] trait — the interface the WebRTC
//! layer will pull frames from. The real implementations are **TODO stubs**:
//! `#[cfg(windows)]` documents a DXGI Desktop Duplication source; elsewhere a
//! no-op source. Neither fabricates frame data — they return `unimplemented!()`
//! / an explicit "not captured" signal, per the honesty requirement.
//!
//! Interface surface (`RawFrame`, the pull methods) is unused by the MVP wiring
//! until real capture + the media-track pump land.
#![allow(dead_code)]

use anyhow::Result;

/// A single captured frame in a raw, unencoded form. The encoder (H.264/VP8)
/// lives in the WebRTC layer; this is deliberately the pre-encode surface.
#[derive(Debug, Clone)]
pub struct RawFrame {
    pub width: u32,
    pub height: u32,
    /// BGRA8888, `width * height * 4` bytes, top-down.
    pub bgra: Vec<u8>,
    /// Monotonic capture timestamp in microseconds.
    pub timestamp_us: u64,
}

/// The pull interface for screen frames. Implementations must be `Send` so a
/// capture task can own them.
pub trait ScreenSource: Send {
    /// Report the source surface size (used to map normalized input coords).
    fn dimensions(&self) -> (u32, u32);

    /// Pull the next frame. Returns `Ok(None)` when no new frame is available
    /// yet (the caller should back off), or an error on capture failure.
    fn next_frame(&mut self) -> Result<Option<RawFrame>>;
}

/// Construct the platform screen source. Currently a stub on every platform.
pub fn open_primary_display() -> Result<Box<dyn ScreenSource>> {
    #[cfg(windows)]
    {
        Ok(Box::new(windows_capture::DxgiDuplication::new()?))
    }
    #[cfg(not(windows))]
    {
        Ok(Box::new(NullScreenSource))
    }
}

// ---------------------------------------------------------------------------
// Windows: DXGI Desktop Duplication (TODO stub)
// ---------------------------------------------------------------------------
#[cfg(windows)]
mod windows_capture {
    use super::*;

    /// TODO: Implement DXGI Desktop Duplication:
    ///   * `D3D11CreateDevice`, `IDXGIOutput1::DuplicateOutput`,
    ///   * `AcquireNextFrame` → copy the `ID3D11Texture2D` into a staging
    ///     texture → `Map` → produce a `RawFrame` (BGRA),
    ///   * handle `DXGI_ERROR_ACCESS_LOST` (resolution/mode change) by
    ///     re-creating the duplication.
    /// No frames are fabricated; until implemented, `next_frame` is unimplemented.
    pub struct DxgiDuplication {
        width: u32,
        height: u32,
    }

    impl DxgiDuplication {
        pub fn new() -> Result<Self> {
            // TODO: query the primary output dimensions during setup.
            Ok(Self {
                width: 0,
                height: 0,
            })
        }
    }

    impl ScreenSource for DxgiDuplication {
        fn dimensions(&self) -> (u32, u32) {
            (self.width, self.height)
        }
        fn next_frame(&mut self) -> Result<Option<RawFrame>> {
            unimplemented!("TODO: DXGI Desktop Duplication capture not yet implemented")
        }
    }
}

// ---------------------------------------------------------------------------
// Non-Windows: null source (compiles, never fabricates frames)
// ---------------------------------------------------------------------------
#[cfg(not(windows))]
struct NullScreenSource;

#[cfg(not(windows))]
impl ScreenSource for NullScreenSource {
    fn dimensions(&self) -> (u32, u32) {
        (0, 0)
    }
    fn next_frame(&mut self) -> Result<Option<RawFrame>> {
        // TODO: no capture backend on non-Windows platforms. Returns no frame
        // rather than faking one.
        Ok(None)
    }
}
