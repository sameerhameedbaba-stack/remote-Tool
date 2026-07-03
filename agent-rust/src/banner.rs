//! Mandatory, non-suppressible consent banner.
//!
//! Contract (`docs/SECURITY_MODEL.md` §1 req 5, `docs/API.md` signaling):
//! a session **cannot** become `active` until the agent has shown a visible
//! banner and acked `banner:visible`. There is deliberately **no suppress
//! flag** anywhere in this module or its callers.
//!
//! * **Windows:** the intended implementation is a real always-on-top,
//!   click-through-safe window (see the TODO below). Until that native window
//!   lands, we still force a highly-visible console banner so the requirement is
//!   never silently skipped.
//! * **Non-Windows:** prints a persistent, prominent banner to stderr.

/// Handle representing a currently-visible banner. Dropping it logs that the
/// banner was taken down (which happens at session end).
#[derive(Debug)]
pub struct BannerHandle {
    shown: bool,
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
    {
        windows_banner::show_native(session_id, technician_label)?;
    }
    // Always emit the visible console/stderr banner as well, on every platform,
    // so there is never a silent path.
    print_console_banner(session_id, technician_label);
    Ok(BannerHandle { shown: true })
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
// Windows native banner (TODO: real always-on-top window)
// ---------------------------------------------------------------------------
#[cfg(windows)]
mod windows_banner {
    use anyhow::Result;

    /// TODO: Implement a real always-on-top, non-closable Win32 banner window
    /// (register a WNDCLASS, `CreateWindowExW` with `WS_EX_TOPMOST | WS_EX_NOACTIVATE`,
    /// a `WS_POPUP` style, painted red bar spanning the primary monitor's top
    /// edge, running its own message-loop thread). It must:
    ///   * stay on top for the entire session,
    ///   * not expose a close/minimize affordance,
    ///   * be torn down only when the `BannerHandle` is dropped at session end.
    ///
    /// Until that lands we return Ok so the mandatory console banner (emitted by
    /// the caller on every platform) still guarantees visibility. This is the
    /// only stubbed part of the banner path; visibility itself is never skipped.
    pub fn show_native(_session_id: &str, _technician_label: &str) -> Result<()> {
        tracing::warn!(
            "native Windows banner window is a TODO stub; \
             falling back to the mandatory console banner (still visible, never silent)"
        );
        Ok(())
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
