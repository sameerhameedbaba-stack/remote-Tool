//! Session state machine.
//!
//! Legal transitions (enforced here):
//!
//! ```text
//!   Pending ──show banner──▶ BannerShown ──ack──▶ Active ──end──▶ Ended
//!      └──────────────────────── end ─────────────────────────────▶ Ended
//! ```
//!
//! The critical invariant from `docs/SECURITY_MODEL.md` §1 req 5: a session may
//! **only** reach [`SessionState::Active`] after the banner has been shown and
//! acknowledged. `Pending → Active` directly is rejected.

use thiserror::Error;

/// Lifecycle states of a support session on the agent side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// `session-control:start` received; banner not yet shown.
    Pending,
    /// Banner is visible; awaiting/holding the ack that is sent to the server.
    BannerShown,
    /// Banner acked and media/data channels may flow.
    Active,
    /// Session finished (by either peer) or aborted.
    Ended,
}

/// Errors from illegal state transitions.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum TransitionError {
    #[error("illegal transition from {from:?} via {action}")]
    Illegal {
        from: SessionState,
        action: &'static str,
    },
}

/// A guarded session whose transitions are the only way to mutate its state.
#[derive(Debug)]
pub struct Session {
    /// The backend session id this state machine tracks.
    #[allow(dead_code)]
    pub id: String,
    state: SessionState,
}

impl Session {
    /// Create a new session in [`SessionState::Pending`].
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            state: SessionState::Pending,
        }
    }

    #[allow(dead_code)]
    pub fn state(&self) -> SessionState {
        self.state
    }

    /// `Pending → BannerShown`. Called after [`crate::banner::show`] succeeds.
    pub fn mark_banner_shown(&mut self) -> Result<(), TransitionError> {
        match self.state {
            SessionState::Pending => {
                self.state = SessionState::BannerShown;
                Ok(())
            }
            from => Err(TransitionError::Illegal {
                from,
                action: "mark_banner_shown",
            }),
        }
    }

    /// `BannerShown → Active`. Only reachable once the banner is visible; a
    /// direct `Pending → Active` is rejected, enforcing the consent invariant.
    pub fn activate(&mut self) -> Result<(), TransitionError> {
        match self.state {
            SessionState::BannerShown => {
                self.state = SessionState::Active;
                Ok(())
            }
            from => Err(TransitionError::Illegal {
                from,
                action: "activate",
            }),
        }
    }

    /// Transition to [`SessionState::Ended`] from any non-ended state.
    pub fn end(&mut self) -> Result<(), TransitionError> {
        match self.state {
            SessionState::Ended => Err(TransitionError::Illegal {
                from: SessionState::Ended,
                action: "end",
            }),
            _ => {
                self.state = SessionState::Ended;
                Ok(())
            }
        }
    }

    #[allow(dead_code)]
    pub fn is_active(&self) -> bool {
        self.state == SessionState::Active
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn happy_path() {
        let mut s = Session::new("s1");
        assert_eq!(s.state(), SessionState::Pending);
        s.mark_banner_shown().unwrap();
        assert_eq!(s.state(), SessionState::BannerShown);
        s.activate().unwrap();
        assert!(s.is_active());
        s.end().unwrap();
        assert_eq!(s.state(), SessionState::Ended);
    }

    #[test]
    fn cannot_activate_without_banner() {
        let mut s = Session::new("s1");
        let err = s.activate().unwrap_err();
        assert_eq!(
            err,
            TransitionError::Illegal {
                from: SessionState::Pending,
                action: "activate"
            }
        );
        assert_eq!(s.state(), SessionState::Pending);
    }

    #[test]
    fn can_end_from_pending() {
        let mut s = Session::new("s1");
        s.end().unwrap();
        assert_eq!(s.state(), SessionState::Ended);
    }

    #[test]
    fn cannot_end_twice() {
        let mut s = Session::new("s1");
        s.end().unwrap();
        assert!(s.end().is_err());
    }

    #[test]
    fn cannot_reshow_banner_after_active() {
        let mut s = Session::new("s1");
        s.mark_banner_shown().unwrap();
        s.activate().unwrap();
        assert!(s.mark_banner_shown().is_err());
    }
}
