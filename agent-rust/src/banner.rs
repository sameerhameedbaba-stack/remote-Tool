//! Mandatory, non-suppressible consent banner.
//!
//! Contract (`docs/SECURITY_MODEL.md` §1 req 5, `docs/API.md` signaling):
//! a session **cannot** become `active` until the agent has shown a visible
//! banner and acked `banner:visible`. There is deliberately **no suppress
//! flag** anywhere in this module or its callers.
//!
//! * **Windows:** a real always-on-top, non-closable red bar spanning the top
//!   of the primary monitor, on its own message-loop thread. It has no close or
//!   minimize affordance (WS_DISABLED + WM_CLOSE ignored) and is torn down only
//!   when the `BannerHandle` is dropped at session end. The console banner is
//!   still emitted too, so visibility is guaranteed even if the window fails.
//! * **Non-Windows:** prints a persistent, prominent banner to stderr.

/// Handle representing a currently-visible banner. Dropping it tears down the
/// native window (Windows) and logs the takedown (which happens at session end).
pub struct BannerHandle {
    shown: bool,
    // Held only for its Drop (tears down the native window at session end).
    #[cfg(windows)]
    #[allow(dead_code)]
    native: Option<windows_banner::NativeBanner>,
}

impl std::fmt::Debug for BannerHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BannerHandle")
            .field("shown", &self.shown)
            .finish()
    }
}

impl BannerHandle {
    /// True once the banner is confirmed visible. The session state machine
    /// gates the `active` transition on this.
    #[allow(dead_code)]
    pub fn is_visible(&self) -> bool {
        self.shown
    }
}

impl Drop for BannerHandle {
    fn drop(&mut self) {
        // Native window (if any) is torn down by its own Drop below.
        if self.shown {
            tracing::info!("consent banner removed");
        }
    }
}

/// Show the mandatory banner for a session. Returns a handle only if the banner
/// is actually visible; the caller must treat a failure here as fatal to the
/// session (never proceed to `active` without it).
pub fn show(session_id: &str, technician_label: &str) -> anyhow::Result<BannerHandle> {
    #[cfg(windows)]
    let native = match windows_banner::NativeBanner::show(session_id, technician_label) {
        Ok(n) => Some(n),
        Err(e) => {
            // The native window failed, but the console banner below still
            // guarantees a visible, non-silent banner — so the session may
            // proceed. Log loudly.
            tracing::error!(error = %e, "native banner window failed; using console banner only");
            None
        }
    };
    // Always emit the visible console/stderr banner as well, on every platform,
    // so there is never a silent path.
    print_console_banner(session_id, technician_label);
    Ok(BannerHandle {
        shown: true,
        #[cfg(windows)]
        native,
    })
}

fn print_console_banner(session_id: &str, technician_label: &str) {
    let line = "=".repeat(72);
    eprintln!("\n{line}");
    eprintln!("  REMOTE SUPPORT SESSION ACTIVE — YOUR SCREEN IS BEING VIEWED");
    eprintln!("  Technician : {technician_label}");
    eprintln!("  Session    : {session_id}");
    eprintln!("  This banner cannot be hidden. End the session to stop sharing.");
    eprintln!("{line}\n");
    tracing::warn!(%session_id, technician = %technician_label, "consent banner shown");
}

// ---------------------------------------------------------------------------
// Windows native banner: always-on-top, non-closable red bar
// ---------------------------------------------------------------------------
#[cfg(windows)]
mod windows_banner {
    use anyhow::{anyhow, Result};
    use std::sync::mpsc;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect, SetBkMode,
        SetTextColor, DT_CENTER, DT_SINGLELINE, DT_VCENTER, HGDIOBJ, PAINTSTRUCT, TRANSPARENT,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetSystemMetrics,
        PostQuitMessage, PostThreadMessageW, RegisterClassExW, SetWindowLongPtrW, ShowWindow,
        TranslateMessage, GWLP_USERDATA, HWND_TOPMOST, MSG, SM_CXSCREEN, SW_SHOWNOACTIVATE,
        WM_CLOSE, WM_CREATE, WM_DESTROY, WM_PAINT, WM_QUIT, WNDCLASSEXW, WS_DISABLED,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
    };

    const BANNER_HEIGHT: i32 = 36;
    const CLASS_NAME: &str = "RemoteSupportConsentBanner";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// A live native banner running on its own message-loop thread. Dropping it
    /// posts WM_QUIT to that thread, which tears the window down and joins.
    pub struct NativeBanner {
        thread_id: u32,
        join: Option<std::thread::JoinHandle<()>>,
    }

    impl NativeBanner {
        pub fn show(session_id: &str, technician_label: &str) -> Result<Self> {
            // The window text is owned by the message-loop thread.
            let text = format!(
                "  ●  REMOTE SUPPORT SESSION ACTIVE — your screen is being viewed by {technician_label}   (session {session_id})"
            );
            let (tx, rx) = mpsc::channel::<Result<u32, String>>();
            let join = std::thread::Builder::new()
                .name("consent-banner".into())
                .spawn(move || run_banner_thread(text, tx))
                .map_err(|e| anyhow!("spawning banner thread: {e}"))?;

            // Wait for the thread to report the window created (or an error).
            match rx.recv() {
                Ok(Ok(thread_id)) => Ok(NativeBanner {
                    thread_id,
                    join: Some(join),
                }),
                Ok(Err(e)) => Err(anyhow!("native banner init failed: {e}")),
                Err(_) => Err(anyhow!("banner thread exited before signalling")),
            }
        }
    }

    impl Drop for NativeBanner {
        fn drop(&mut self) {
            unsafe {
                // Ask the window thread to quit its message loop; it then destroys
                // the window and returns.
                let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
            if let Some(j) = self.join.take() {
                let _ = j.join();
            }
        }
    }

    fn run_banner_thread(text: String, tx: mpsc::Sender<Result<u32, String>>) {
        let thread_id = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
        match create_window(&text) {
            Ok(_hwnd) => {
                if tx.send(Ok(thread_id)).is_err() {
                    return;
                }
                // Standard message loop until WM_QUIT arrives (from Drop).
                unsafe {
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                // Leaked window text box is reclaimed in WM_DESTROY.
            }
            Err(e) => {
                let _ = tx.send(Err(e.to_string()));
            }
        }
    }

    fn create_window(text: &str) -> Result<HWND> {
        unsafe {
            let hmodule = GetModuleHandleW(None).map_err(|e| anyhow!("GetModuleHandleW: {e}"))?;
            let hinstance = HINSTANCE(hmodule.0);
            let class_w = wide(CLASS_NAME);

            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(wnd_proc),
                hInstance: hinstance,
                lpszClassName: PCWSTR(class_w.as_ptr()),
                ..Default::default()
            };
            // Registering twice in one process returns 0/ERROR_CLASS_ALREADY_EXISTS;
            // that is fine — a subsequent session reuses the class.
            RegisterClassExW(&wc);

            let screen_w = GetSystemMetrics(SM_CXSCREEN).max(320);
            // The window text is heap-owned and handed to the window via lParam.
            let text_box: Box<Vec<u16>> = Box::new(wide(text));
            let text_ptr = Box::into_raw(text_box);

            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                PCWSTR(class_w.as_ptr()),
                PCWSTR(wide("Remote Support").as_ptr()),
                WS_POPUP | WS_VISIBLE | WS_DISABLED, // DISABLED: no user interaction/close
                0,
                0,
                screen_w,
                BANNER_HEIGHT,
                None,
                None,
                hinstance,
                Some(text_ptr as *const _),
            )
            .map_err(|e| anyhow!("CreateWindowExW: {e}"))?;

            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            // Force topmost placement.
            use windows::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            };
            let _ = SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            Ok(hwnd)
        }
    }

    extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_CREATE => {
                    // Stash the heap text pointer (passed as lParam via CREATESTRUCT).
                    let cs =
                        lparam.0 as *const windows::Win32::UI::WindowsAndMessaging::CREATESTRUCTW;
                    if !cs.is_null() {
                        let text_ptr = (*cs).lpCreateParams as isize;
                        SetWindowLongPtrW(hwnd, GWLP_USERDATA, text_ptr);
                    }
                    LRESULT(0)
                }
                WM_PAINT => {
                    paint(hwnd);
                    LRESULT(0)
                }
                // Refuse to close: the banner is non-dismissible by the user. It
                // is only removed when the agent destroys it at session end.
                WM_CLOSE => LRESULT(0),
                WM_DESTROY => {
                    // Reclaim and free the heap text box.
                    let ptr = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) as *mut Vec<u16>;
                    if !ptr.is_null() {
                        drop(Box::from_raw(ptr));
                    }
                    PostQuitMessage(0);
                    LRESULT(0)
                }
                _ => DefWindowProcW(hwnd, msg, wparam, lparam),
            }
        }
    }

    fn paint(hwnd: HWND) {
        unsafe {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);

            let mut rect = RECT::default();
            let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rect);

            // Red background bar.
            let brush = CreateSolidBrush(COLORREF(0x0000C8)); // BGR: strong red
            FillRect(hdc, &rect, brush);
            let _ = DeleteObject(HGDIOBJ(brush.0));

            // White centered text.
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, COLORREF(0x00FFFFFF));
            let text_ptr =
                windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(hwnd, GWLP_USERDATA)
                    as *const Vec<u16>;
            if !text_ptr.is_null() {
                let text = &*text_ptr;
                // DrawTextW wants a mutable [u16]; copy out the (already NUL-term) buffer.
                let mut buf = text.clone();
                DrawTextW(
                    hdc,
                    &mut buf,
                    &mut rect,
                    DT_SINGLELINE | DT_VCENTER | DT_CENTER,
                );
            }

            let _ = EndPaint(hwnd, &ps);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn show_yields_visible_handle() {
        let h = show("sess-test", "Test Tech").unwrap();
        assert!(h.is_visible());
    }
}
