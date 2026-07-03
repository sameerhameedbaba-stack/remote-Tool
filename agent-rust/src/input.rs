//! Untrusted remote-input handling.
//!
//! Contract (`docs/SECURITY_MODEL.md` §6): peer input is untrusted. The agent
//! injects **OS input events only** — never shell commands. There is
//! deliberately **no code path** from an input message to process execution.
//!
//! This module implements the *validation* for real (key-code allowlist,
//! normalized-coordinate bounds, button/action allowlists) on every platform.
//! The actual OS injection is a TODO stub: `#[cfg(windows)]` documents the
//! `SendInput` interface; elsewhere it only logs.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A remote input event, matching the `input` data-channel wire format.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum InputEvent {
    Mouse {
        /// Normalized [0,1] fraction of the streamed surface width.
        x: f64,
        /// Normalized [0,1] fraction of the streamed surface height.
        y: f64,
        button: String,
        action: String,
    },
    Key {
        /// A `KeyboardEvent.code`-style value, e.g. `KeyA`, `Digit1`, `Enter`.
        code: String,
        action: String,
        #[serde(default)]
        modifiers: Vec<String>,
    },
}

/// Validation failures. Every rejection is audit-worthy.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum InputError {
    #[error("coordinate out of [0,1] bounds: ({0}, {1})")]
    CoordOutOfBounds(String, String),
    #[error("disallowed mouse button: {0}")]
    BadButton(String),
    #[error("disallowed action: {0}")]
    BadAction(String),
    #[error("disallowed key code: {0}")]
    BadKeyCode(String),
    #[error("disallowed modifier: {0}")]
    BadModifier(String),
}

const ALLOWED_BUTTONS: &[&str] = &["left", "right", "middle"];
const ALLOWED_MOUSE_ACTIONS: &[&str] = &["down", "up", "move"];
const ALLOWED_KEY_ACTIONS: &[&str] = &["down", "up"];
const ALLOWED_MODIFIERS: &[&str] = &["ctrl", "shift", "alt", "meta"];

/// Non-alphanumeric key codes that are explicitly permitted. Alphanumerics
/// (`KeyA`..`KeyZ`, `Digit0`..`Digit9`) and function keys (`F1`..`F24`) are
/// matched structurally in [`is_allowed_key_code`].
const ALLOWED_NAMED_KEYS: &[&str] = &[
    "Enter",
    "Escape",
    "Backspace",
    "Tab",
    "Space",
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Backslash",
    "Semicolon",
    "Quote",
    "Backquote",
    "Comma",
    "Period",
    "Slash",
    "CapsLock",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Insert",
    "Delete",
    "ControlLeft",
    "ControlRight",
    "ShiftLeft",
    "ShiftRight",
    "AltLeft",
    "AltRight",
    "MetaLeft",
    "MetaRight",
    "Numpad0",
    "Numpad1",
    "Numpad2",
    "Numpad3",
    "Numpad4",
    "Numpad5",
    "Numpad6",
    "Numpad7",
    "Numpad8",
    "Numpad9",
    "NumpadAdd",
    "NumpadSubtract",
    "NumpadMultiply",
    "NumpadDivide",
    "NumpadDecimal",
    "NumpadEnter",
];

/// True if `code` is on the allowlist. This is the security boundary that keeps
/// input constrained to real keys; anything unrecognized is rejected.
pub fn is_allowed_key_code(code: &str) -> bool {
    // KeyA..KeyZ
    if let Some(rest) = code.strip_prefix("Key") {
        return rest.len() == 1 && rest.chars().all(|c| c.is_ascii_uppercase());
    }
    // Digit0..Digit9
    if let Some(rest) = code.strip_prefix("Digit") {
        return rest.len() == 1 && rest.chars().all(|c| c.is_ascii_digit());
    }
    // F1..F24
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u8>() {
            return (1..=24).contains(&n);
        }
    }
    ALLOWED_NAMED_KEYS.contains(&code)
}

/// Validate an input event against the allowlists and coordinate bounds.
pub fn validate(ev: &InputEvent) -> Result<(), InputError> {
    match ev {
        InputEvent::Mouse {
            x,
            y,
            button,
            action,
        } => {
            if !(0.0..=1.0).contains(x) || !(0.0..=1.0).contains(y) || x.is_nan() || y.is_nan() {
                return Err(InputError::CoordOutOfBounds(x.to_string(), y.to_string()));
            }
            if !ALLOWED_MOUSE_ACTIONS.contains(&action.as_str()) {
                return Err(InputError::BadAction(action.clone()));
            }
            // A move needs no button; a click must name an allowed button.
            if action != "move" && !ALLOWED_BUTTONS.contains(&button.as_str()) {
                return Err(InputError::BadButton(button.clone()));
            }
            Ok(())
        }
        InputEvent::Key {
            code,
            action,
            modifiers,
        } => {
            if !ALLOWED_KEY_ACTIONS.contains(&action.as_str()) {
                return Err(InputError::BadAction(action.clone()));
            }
            if !is_allowed_key_code(code) {
                return Err(InputError::BadKeyCode(code.clone()));
            }
            for m in modifiers {
                if !ALLOWED_MODIFIERS.contains(&m.as_str()) {
                    return Err(InputError::BadModifier(m.clone()));
                }
            }
            Ok(())
        }
    }
}

/// Validate then inject a peer input event.
///
/// Note the ordering: we validate **before** any platform call, and there is no
/// branch that turns an event into a command/shell invocation.
pub fn apply(ev: &InputEvent) -> Result<(), InputError> {
    validate(ev)?;
    // Audit-worthy: log only that a remote-control action occurred, as a
    // discriminant (kind + up/down/move). The key `code`, coordinates, and
    // modifiers are deliberately NOT logged — the audit trail records that an
    // action happened, never keystroke contents (docs/SECURITY_MODEL.md §4).
    // The durable, aggregated `input.command_attempt` record is emitted to the
    // backend via the agent's audit reporter.
    let (kind, action) = match ev {
        InputEvent::Mouse { action, .. } => ("mouse", action.as_str()),
        InputEvent::Key { action, .. } => ("key", action.as_str()),
    };
    tracing::info!(target: "audit.input", kind, action, "input.command_attempt");
    inject(ev);
    Ok(())
}

// ---------------------------------------------------------------------------
// Platform injection (TODO stubs — no real OS input yet)
// ---------------------------------------------------------------------------
#[cfg(windows)]
fn inject(ev: &InputEvent) {
    // TODO: Translate the validated event into a `windows`-crate `SendInput`
    // call:
    //   * Mouse: map normalized (x,y) → absolute virtual-desktop coordinates
    //     (0..65535), build an `INPUT` with `MOUSEINPUT`
    //     (`MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | *_MOVE/DOWN/UP`).
    //   * Key: map the `code` allowlist entry → virtual-key / scan code, build
    //     a `KEYBDINPUT` (`KEYEVENTF_SCANCODE`, `*_KEYUP` for `up`).
    // The event is already validated above; injection performs no parsing of
    // its own and never spawns a process.
    let _ = ev;
    tracing::debug!("SendInput injection is a TODO stub (Windows)");
}

#[cfg(not(windows))]
fn inject(ev: &InputEvent) {
    // Log only the discriminant, never the event payload (no keystroke capture).
    let kind = match ev {
        InputEvent::Mouse { .. } => "mouse",
        InputEvent::Key { .. } => "key",
    };
    tracing::debug!(
        kind,
        "input injection not supported on this platform (log-only stub)"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_letter_and_digit_keys() {
        assert!(is_allowed_key_code("KeyA"));
        assert!(is_allowed_key_code("KeyZ"));
        assert!(is_allowed_key_code("Digit0"));
        assert!(is_allowed_key_code("F5"));
        assert!(is_allowed_key_code("Enter"));
    }

    #[test]
    fn rejects_bogus_key_codes() {
        assert!(!is_allowed_key_code("Keyaa"));
        assert!(!is_allowed_key_code("Key1"));
        assert!(!is_allowed_key_code("Digit12"));
        assert!(!is_allowed_key_code("F25"));
        assert!(!is_allowed_key_code("rm -rf /"));
        assert!(!is_allowed_key_code("cmd.exe"));
        assert!(!is_allowed_key_code(""));
    }

    #[test]
    fn validates_mouse_bounds() {
        let ok = InputEvent::Mouse {
            x: 0.5,
            y: 0.5,
            button: "left".into(),
            action: "down".into(),
        };
        assert!(validate(&ok).is_ok());

        let oob = InputEvent::Mouse {
            x: 1.5,
            y: 0.5,
            button: "left".into(),
            action: "down".into(),
        };
        assert!(matches!(
            validate(&oob),
            Err(InputError::CoordOutOfBounds(..))
        ));
    }

    #[test]
    fn rejects_bad_button_and_modifier() {
        let bad_btn = InputEvent::Mouse {
            x: 0.1,
            y: 0.1,
            button: "extra7".into(),
            action: "down".into(),
        };
        assert!(matches!(validate(&bad_btn), Err(InputError::BadButton(_))));

        let bad_mod = InputEvent::Key {
            code: "KeyA".into(),
            action: "down".into(),
            modifiers: vec!["superhyper".into()],
        };
        assert!(matches!(
            validate(&bad_mod),
            Err(InputError::BadModifier(_))
        ));
    }

    #[test]
    fn move_needs_no_button() {
        let mv = InputEvent::Mouse {
            x: 0.2,
            y: 0.3,
            button: "".into(),
            action: "move".into(),
        };
        assert!(validate(&mv).is_ok());
    }

    #[test]
    fn parses_wire_format() {
        let raw = r#"{ "t": "key", "code": "KeyA", "action": "down", "modifiers": ["ctrl"] }"#;
        let ev: InputEvent = serde_json::from_str(raw).unwrap();
        assert!(validate(&ev).is_ok());
    }
}
