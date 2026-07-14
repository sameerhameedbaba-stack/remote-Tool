//! Untrusted remote-input handling.
//!
//! Contract (`docs/SECURITY_MODEL.md` §6): peer input is untrusted. The agent
//! injects **OS input events only** — never shell commands. There is
//! deliberately **no code path** from an input message to process execution.
//!
//! This module implements the *validation* for real (key-code allowlist,
//! normalized-coordinate bounds, button/action allowlists) on every platform.
//! On Windows the validated event is injected via `SendInput` (mouse absolute
//! move/click, keyboard virtual-key up/down with modifier bracketing). On other
//! platforms injection is a log-only no-op (dev/CI).

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
// Platform injection
// ---------------------------------------------------------------------------
#[cfg(windows)]
fn inject(ev: &InputEvent) {
    // The event is already validated above. Injection performs no parsing of its
    // own and never spawns a process — it only synthesizes OS input via SendInput.
    let inputs = win_input::build(ev);
    if inputs.is_empty() {
        return;
    }
    unsafe {
        use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT};
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        if sent as usize != inputs.len() {
            tracing::warn!(
                sent,
                expected = inputs.len(),
                "SendInput injected fewer events than requested"
            );
        }
    }
}

/// Translates a validated [`InputEvent`] into Win32 `INPUT` structures. Kept in
/// its own module so the virtual-key mapping is unit-testable and the `unsafe`
/// SendInput call above stays tiny.
#[cfg(windows)]
mod win_input {
    use super::InputEvent;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_KEYUP, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
        MOUSEEVENTF_RIGHTUP, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
    };

    pub(super) fn build(ev: &InputEvent) -> Vec<INPUT> {
        match ev {
            InputEvent::Mouse {
                x,
                y,
                button,
                action,
            } => build_mouse(*x, *y, button, action),
            InputEvent::Key {
                code,
                action,
                modifiers,
            } => build_key(code, action, modifiers),
        }
    }

    fn mouse_input(dx: i32, dy: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn build_mouse(x: f64, y: f64, button: &str, action: &str) -> Vec<INPUT> {
        // Normalized [0,1] over the primary display → 0..65535 absolute coords.
        let dx = (x.clamp(0.0, 1.0) * 65535.0).round() as i32;
        let dy = (y.clamp(0.0, 1.0) * 65535.0).round() as i32;
        // Always position the cursor (ABSOLUTE|MOVE), then apply any button flag.
        let mut flags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE;
        match (action, button) {
            ("move", _) => {}
            ("down", "left") => flags |= MOUSEEVENTF_LEFTDOWN,
            ("up", "left") => flags |= MOUSEEVENTF_LEFTUP,
            ("down", "right") => flags |= MOUSEEVENTF_RIGHTDOWN,
            ("up", "right") => flags |= MOUSEEVENTF_RIGHTUP,
            ("down", "middle") => flags |= MOUSEEVENTF_MIDDLEDOWN,
            ("up", "middle") => flags |= MOUSEEVENTF_MIDDLEUP,
            _ => {}
        }
        vec![mouse_input(dx, dy, flags)]
    }

    fn key_input(vk: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: if up {
                        KEYEVENTF_KEYUP
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn build_key(code: &str, action: &str, modifiers: &[String]) -> Vec<INPUT> {
        let up = action == "up";
        let Some(vk) = super::vk_for_code(code) else {
            return Vec::new();
        };
        // Make each down/up self-contained: on down, press modifiers before the
        // key; on up, release the key before the modifiers. This lets shortcuts
        // like Ctrl+C work without relying on separate modifier key events.
        let mut out = Vec::with_capacity(modifiers.len() + 1);
        let mods: Vec<u16> = modifiers
            .iter()
            .filter_map(|m| vk_for_modifier(m))
            .collect();
        if up {
            out.push(key_input(vk, true));
            for m in mods.iter().rev() {
                out.push(key_input(*m, true));
            }
        } else {
            for m in &mods {
                out.push(key_input(*m, false));
            }
            out.push(key_input(vk, false));
        }
        out
    }

    fn vk_for_modifier(m: &str) -> Option<u16> {
        Some(match m {
            "ctrl" => 0x11,  // VK_CONTROL
            "shift" => 0x10, // VK_SHIFT
            "alt" => 0x12,   // VK_MENU
            "meta" => 0x5B,  // VK_LWIN
            _ => return None,
        })
    }
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

/// Maps a validated `KeyboardEvent.code` allowlist entry to a Win32 virtual-key
/// code. Pure and platform-independent so it is unit-tested on every host.
/// Returns `None` for anything not on the allowlist (defense in depth — this is
/// only ever called after [`validate`], but never trusts that). Only invoked by
/// the Windows injection path; the mapping table is still exercised by tests on
/// all hosts.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn vk_for_code(code: &str) -> Option<u16> {
    // KeyA..KeyZ → 'A'..'Z' (VK is the ASCII uppercase codepoint).
    if let Some(rest) = code.strip_prefix("Key") {
        if rest.len() == 1 {
            let c = rest.chars().next().unwrap();
            if c.is_ascii_uppercase() {
                return Some(c as u16);
            }
        }
        return None;
    }
    // Digit0..Digit9 → '0'..'9'.
    if let Some(rest) = code.strip_prefix("Digit") {
        if rest.len() == 1 {
            let c = rest.chars().next().unwrap();
            if c.is_ascii_digit() {
                return Some(c as u16);
            }
        }
        return None;
    }
    // F1..F24 → VK_F1 (0x70) upward.
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u8>() {
            if (1..=24).contains(&n) {
                return Some(0x70 + (n as u16 - 1));
            }
        }
        return None;
    }
    Some(match code {
        "Enter" | "NumpadEnter" => 0x0D,
        "Escape" => 0x1B,
        "Backspace" => 0x08,
        "Tab" => 0x09,
        "Space" => 0x20,
        "Minus" => 0xBD,
        "Equal" => 0xBB,
        "BracketLeft" => 0xDB,
        "BracketRight" => 0xDD,
        "Backslash" => 0xDC,
        "Semicolon" => 0xBA,
        "Quote" => 0xDE,
        "Backquote" => 0xC0,
        "Comma" => 0xBC,
        "Period" => 0xBE,
        "Slash" => 0xBF,
        "CapsLock" => 0x14,
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "Home" => 0x24,
        "End" => 0x23,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "Insert" => 0x2D,
        "Delete" => 0x2E,
        "ControlLeft" => 0xA2,
        "ControlRight" => 0xA3,
        "ShiftLeft" => 0xA0,
        "ShiftRight" => 0xA1,
        "AltLeft" => 0xA4,
        "AltRight" => 0xA5,
        "MetaLeft" => 0x5B,
        "MetaRight" => 0x5C,
        "Numpad0" => 0x60,
        "Numpad1" => 0x61,
        "Numpad2" => 0x62,
        "Numpad3" => 0x63,
        "Numpad4" => 0x64,
        "Numpad5" => 0x65,
        "Numpad6" => 0x66,
        "Numpad7" => 0x67,
        "Numpad8" => 0x68,
        "Numpad9" => 0x69,
        "NumpadAdd" => 0x6B,
        "NumpadSubtract" => 0x6D,
        "NumpadMultiply" => 0x6A,
        "NumpadDivide" => 0x6F,
        "NumpadDecimal" => 0x6E,
        _ => return None,
    })
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
    fn vk_mapping_matches_allowlist_and_rejects_junk() {
        // Alphanumerics map to their ASCII VK codes.
        assert_eq!(vk_for_code("KeyA"), Some(0x41));
        assert_eq!(vk_for_code("KeyZ"), Some(0x5A));
        assert_eq!(vk_for_code("Digit0"), Some(0x30));
        assert_eq!(vk_for_code("Digit9"), Some(0x39));
        // Function keys are contiguous from VK_F1.
        assert_eq!(vk_for_code("F1"), Some(0x70));
        assert_eq!(vk_for_code("F12"), Some(0x7B));
        // Named keys resolve; enter/numpad-enter share VK_RETURN.
        assert_eq!(vk_for_code("Enter"), Some(0x0D));
        assert_eq!(vk_for_code("NumpadEnter"), Some(0x0D));
        assert_eq!(vk_for_code("ArrowLeft"), Some(0x25));
        // Anything off the allowlist is rejected (defense in depth).
        assert_eq!(vk_for_code("cmd.exe"), None);
        assert_eq!(vk_for_code("Key1"), None);
        assert_eq!(vk_for_code("F25"), None);
        assert_eq!(vk_for_code(""), None);
        // Every allowlisted code must have a VK mapping (no silent gaps).
        for k in ALLOWED_NAMED_KEYS {
            assert!(vk_for_code(k).is_some(), "missing VK for {k}");
        }
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
    fn apply_accepts_allowed_and_rejects_disallowed() {
        // Allowed event: validate + audit-log + inject stub, returns Ok.
        let ok = InputEvent::Key {
            code: "KeyA".into(),
            action: "down".into(),
            modifiers: vec!["ctrl".into()],
        };
        assert!(apply(&ok).is_ok());

        // Rejected event: apply() must fail at validation and never inject.
        let bad = InputEvent::Key {
            code: "rm -rf /".into(),
            action: "down".into(),
            modifiers: vec![],
        };
        assert!(matches!(apply(&bad), Err(InputError::BadKeyCode(_))));

        // A mouse action with a disallowed button is also rejected by apply().
        let bad_mouse = InputEvent::Mouse {
            x: 0.5,
            y: 0.5,
            button: "extra7".into(),
            action: "down".into(),
        };
        assert!(matches!(apply(&bad_mouse), Err(InputError::BadButton(_))));
    }

    #[test]
    fn parses_wire_format() {
        let raw = r#"{ "t": "key", "code": "KeyA", "action": "down", "modifiers": ["ctrl"] }"#;
        let ev: InputEvent = serde_json::from_str(raw).unwrap();
        assert!(validate(&ev).is_ok());
    }
}
