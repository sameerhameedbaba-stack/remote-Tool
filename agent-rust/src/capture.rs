//! Screen capture.
//!
//! [`ScreenSource`] is the interface the streaming loop pulls frames from. On
//! Windows it is implemented with GDI `BitBlt` of the primary display into a
//! top-down 32-bit DIB, yielding a BGRA frame. GDI is chosen over DXGI Desktop
//! Duplication for the MVP: far fewer moving parts, works on every Windows
//! edition and over RDP/session-0 quirks, and is simple enough to be correct.
//! DXGI is a future performance optimization. On non-Windows hosts the source
//! yields no frames (dev/CI) rather than fabricating any.
#![allow(dead_code)]

use anyhow::Result;

/// A single captured frame in a raw, unencoded form (BGRA8888, top-down).
#[derive(Debug, Clone)]
pub struct RawFrame {
    pub width: u32,
    pub height: u32,
    /// BGRA8888, `width * height * 4` bytes, top-down (row 0 = top).
    pub bgra: Vec<u8>,
    /// Monotonic capture timestamp in microseconds.
    pub timestamp_us: u64,
}

/// The pull interface for screen frames. Implementations must be `Send` so a
/// capture task can own them.
pub trait ScreenSource: Send {
    /// Report the source surface size (used to map normalized input coords).
    fn dimensions(&self) -> (u32, u32);

    /// Pull the current frame. Returns `Ok(None)` when nothing is available
    /// (e.g. non-Windows), or an error on capture failure.
    fn next_frame(&mut self) -> Result<Option<RawFrame>>;
}

/// Construct the platform screen source for the primary display.
///
/// If `REMOTE_AGENT_CAPTURE_TEST_PATTERN` is set, a synthetic moving test
/// pattern is used instead of real capture (any platform). This is a diagnostic
/// aid — clearly not real screen content — used by the end-to-end test to
/// exercise the full encode→chunk→channel→decode pipeline on Linux CI where
/// there is no desktop to capture. It is never selected in normal operation.
pub fn open_primary_display() -> Result<Box<dyn ScreenSource>> {
    if std::env::var_os("REMOTE_AGENT_CAPTURE_TEST_PATTERN").is_some() {
        tracing::warn!(
            "using synthetic capture test pattern (diagnostic; not real screen content)"
        );
        return Ok(Box::new(TestPatternSource::new()));
    }
    #[cfg(windows)]
    {
        Ok(Box::new(windows_capture::GdiCapture::new()?))
    }
    #[cfg(not(windows))]
    {
        Ok(Box::new(NullScreenSource))
    }
}

// ---------------------------------------------------------------------------
// Synthetic test pattern (diagnostic only, env-gated)
// ---------------------------------------------------------------------------
/// A 320×240 BGRA source that paints a gradient plus a moving box so successive
/// frames differ (real JPEG content, not a flat fill). Not real screen capture.
struct TestPatternSource {
    frame: u64,
    start: std::time::Instant,
}

impl TestPatternSource {
    const W: u32 = 320;
    const H: u32 = 240;
    fn new() -> Self {
        Self {
            frame: 0,
            start: std::time::Instant::now(),
        }
    }
}

impl ScreenSource for TestPatternSource {
    fn dimensions(&self) -> (u32, u32) {
        (Self::W, Self::H)
    }
    fn next_frame(&mut self) -> Result<Option<RawFrame>> {
        let (w, h) = (Self::W as usize, Self::H as usize);
        let mut bgra = vec![0u8; w * h * 4];
        let t = self.frame;
        // A moving box position derived from the frame counter.
        let bx = (t as usize * 4) % w;
        let by = (t as usize * 3) % h;
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                let in_box = x >= bx && x < bx + 40 && y >= by && y < by + 40;
                // BGRA: gradient background, white moving box.
                bgra[i] = if in_box { 255 } else { (x * 255 / w) as u8 }; // B
                bgra[i + 1] = if in_box { 255 } else { (y * 255 / h) as u8 }; // G
                bgra[i + 2] = if in_box { 255 } else { 64 }; // R
                bgra[i + 3] = 255; // A
            }
        }
        self.frame = self.frame.wrapping_add(1);
        Ok(Some(RawFrame {
            width: Self::W,
            height: Self::H,
            bgra,
            timestamp_us: self.start.elapsed().as_micros() as u64,
        }))
    }
}

// ---------------------------------------------------------------------------
// Windows: GDI BitBlt capture of the primary display
// ---------------------------------------------------------------------------
#[cfg(windows)]
mod windows_capture {
    use super::*;
    use anyhow::{anyhow, Context};
    use std::time::Instant;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HGDIOBJ, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    /// GDI-backed capture of the primary monitor. Holds no GDI handles between
    /// calls (so it stays `Send`); each `next_frame` acquires and releases its
    /// own DCs/bitmap. `start` anchors monotonic timestamps.
    pub struct GdiCapture {
        width: u32,
        height: u32,
        start: Instant,
    }

    impl GdiCapture {
        pub fn new() -> Result<Self> {
            let (width, height) = primary_dimensions();
            if width == 0 || height == 0 {
                return Err(anyhow!("primary display reported zero dimensions"));
            }
            Ok(Self {
                width,
                height,
                start: Instant::now(),
            })
        }

        fn capture(&mut self) -> Result<RawFrame> {
            // Re-read dimensions each frame so a resolution change is picked up.
            let (w, h) = primary_dimensions();
            if w == 0 || h == 0 {
                return Err(anyhow!("primary display reported zero dimensions"));
            }
            self.width = w;
            self.height = h;

            unsafe {
                let screen_dc = GetDC(HWND(std::ptr::null_mut()));
                if screen_dc.is_invalid() {
                    return Err(anyhow!("GetDC(screen) failed"));
                }
                // Ensure the screen DC is always released.
                let _screen_guard = ReleaseGuard(screen_dc);

                let mem_dc = CreateCompatibleDC(screen_dc);
                if mem_dc.is_invalid() {
                    return Err(anyhow!("CreateCompatibleDC failed"));
                }
                let _mem_guard = DeleteDcGuard(mem_dc);

                let bitmap = CreateCompatibleBitmap(screen_dc, w as i32, h as i32);
                if bitmap.is_invalid() {
                    return Err(anyhow!("CreateCompatibleBitmap failed"));
                }
                let _bmp_guard = DeleteObjGuard(HGDIOBJ(bitmap.0));

                let prev = SelectObject(mem_dc, HGDIOBJ(bitmap.0));

                BitBlt(mem_dc, 0, 0, w as i32, h as i32, screen_dc, 0, 0, SRCCOPY)
                    .context("BitBlt of primary display failed")?;

                // Restore and pull the pixels out as a top-down 32-bit DIB.
                SelectObject(mem_dc, prev);

                let mut info = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: w as i32,
                        biHeight: -(h as i32), // negative → top-down
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    ..Default::default()
                };

                let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
                let scanlines = GetDIBits(
                    mem_dc,
                    bitmap,
                    0,
                    h,
                    Some(buf.as_mut_ptr() as *mut _),
                    &mut info,
                    DIB_RGB_COLORS,
                );
                if scanlines == 0 {
                    return Err(anyhow!("GetDIBits returned 0 scanlines"));
                }

                Ok(RawFrame {
                    width: w,
                    height: h,
                    bgra: buf,
                    timestamp_us: self.start.elapsed().as_micros() as u64,
                })
            }
        }
    }

    impl ScreenSource for GdiCapture {
        fn dimensions(&self) -> (u32, u32) {
            (self.width, self.height)
        }
        fn next_frame(&mut self) -> Result<Option<RawFrame>> {
            Ok(Some(self.capture()?))
        }
    }

    fn primary_dimensions() -> (u32, u32) {
        unsafe {
            let w = GetSystemMetrics(SM_CXSCREEN);
            let h = GetSystemMetrics(SM_CYSCREEN);
            (w.max(0) as u32, h.max(0) as u32)
        }
    }

    // RAII guards so a mid-function early return never leaks a GDI handle.
    struct ReleaseGuard(windows::Win32::Graphics::Gdi::HDC);
    impl Drop for ReleaseGuard {
        fn drop(&mut self) {
            unsafe {
                ReleaseDC(HWND(std::ptr::null_mut()), self.0);
            }
        }
    }
    struct DeleteDcGuard(windows::Win32::Graphics::Gdi::HDC);
    impl Drop for DeleteDcGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteDC(self.0);
            }
        }
    }
    struct DeleteObjGuard(HGDIOBJ);
    impl Drop for DeleteObjGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteObject(self.0);
            }
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
        // No capture backend off Windows. Returns no frame rather than faking one.
        Ok(None)
    }
}
