# remote-agent (Rust)

The endpoint agent for the consented, audited, banner-enforced remote-support
MVP — the safe subset of a ScreenConnect-style tool. It streams screen and
relays input/clipboard/file over WebRTC. It has **no** terminal, PowerShell,
SYSTEM shell, or remote-script surface, and **no** hidden/silent session mode.

Conforms to the authoritative contract in `../docs/API.md`,
`../docs/ARCHITECTURE.md` (§2.2), and `../docs/SECURITY_MODEL.md`.

## Build & test

Verified on Linux CI with:

```bash
cargo check      # cross-platform core + cfg-gated Windows stubs
cargo test       # 32 unit tests (sanitization, allowlist, state machine, serde)
cargo clippy --all-targets
cargo fmt --check
```

Windows-only functionality (DXGI capture, `SendInput`, DPAPI, the native banner
window, and Windows-service registration) is behind `#[cfg(windows)]` with
compiling `#[cfg(not(windows))]` counterparts, so the crate checks cleanly on
the Linux host. The `windows` crate is pulled only on Windows targets.

## Run modes

One binary, several subcommands (`clap`):

| Command                 | Mode        | What it does |
|-------------------------|-------------|--------------|
| `remote-agent service`  | unattended  | Load/enroll device token, heartbeat every 15s, connect `/ws/agent`, wait for `session-control:start`, show banner, run session. |
| `remote-agent portable` | attended    | Prompt for a session code, `POST /attended/join`, connect signaling, show banner, run session. |
| `remote-agent enroll`   | provisioning| One-shot: `POST /agent/enroll`, persist the device token, exit. |
| `remote-agent install`  | service reg | Register the Windows service (cfg-gated; no-op with message off Windows). |
| `remote-agent uninstall`| service reg | Unregister the Windows service (cfg-gated; no-op off Windows). |

## Configuration (env, with CLI overrides)

Agent-specific vars (kept separate from the console's `NEXT_PUBLIC_*` browser
vars). No secrets are compiled in.

| Var | Default | Meaning |
|-----|---------|---------|
| `REMOTE_AGENT_API_BASE` | `http://localhost:8080` | REST base URL |
| `REMOTE_AGENT_WS_BASE` | `ws://localhost:8080` | WebSocket base URL |
| `REMOTE_AGENT_ENROLLMENT_TOKEN` | — | shared enrollment token (enroll only) |
| `REMOTE_AGENT_TOKEN_PATH` | per-user data dir | where the device token is persisted |
| `REMOTE_AGENT_DOWNLOADS_DIR` | per-user data dir | fixed directory for received files |
| `REMOTE_AGENT_ICE_SERVERS` | `[]` | JSON ICE server list for the service flow |
| `RUST_LOG` | `info` | tracing filter |

CLI overrides: `--api-base`, `--ws-base`, `--enrollment-token` (global flags).

## Enrolling

```bash
REMOTE_AGENT_ENROLLMENT_TOKEN=<token> \
  remote-agent --api-base http://localhost:8080 enroll --name FRONT-DESK-01
```

The returned `device_token` is persisted via `token_store`:
- **Windows:** DPAPI (`CryptProtectData`), current-user scope.
- **Non-Windows (dev/CI):** plain file, `0600`, with a loud **INSECURE**
  warning. Never ship the non-Windows fallback to end users.

## Security-relevant behavior (implemented for real)

- **Mandatory banner:** the session state machine cannot reach `active` until
  the banner is shown and `banner:visible` is acked. No suppress flag exists.
- **Input validation:** key-code allowlist + normalized-coordinate bounds +
  button/modifier allowlists. No code path from a data-channel message to
  process/shell execution. Accepted actions are logged for `input.command_attempt`.
- **File sanitization:** peer file names are reduced to a safe basename (no
  separators, no `..`, no drive/UNC prefix) and written only inside the fixed
  downloads dir, with size caps. Cross-platform, unit-tested.
- **Clipboard:** text only; control chars and oversize payloads rejected.

## What is stubbed (honest list)

Each is an explicit `// TODO:` with the interface present — never faked:

- **Screen capture** (`capture.rs`): `ScreenSource` trait defined; Windows DXGI
  Desktop Duplication and the non-Windows source are `unimplemented!()`/no-frame
  stubs. No fabricated frames.
- **WebRTC media track** (`webrtc.rs`): `attach_screen_track` is a stub; the
  encode + `TrackLocalStaticSample` pump is TODO. Data channels and offer/
  answer/ICE plumbing are real.
- **Input injection** (`input.rs`): `SendInput` is a TODO stub; **validation is
  real** on all platforms.
- **Clipboard OS get/set** (`clipboard.rs`): `CF_UNICODETEXT` get/set is a TODO
  stub; validation is real.
- **Native banner window** (`banner.rs`): the always-on-top Win32 window is a
  TODO; a mandatory, non-suppressible console banner is always shown so
  visibility is never skipped.
- **DPAPI** (`token_store.rs`): implemented for Windows (unverified on the Linux
  CI host); non-Windows is the documented INSECURE dev fallback.
- **Signed update** (`update.rs`): `UpdateChecker` interface + pinned-key flow
  defined; all bodies `unimplemented!()`. No network calls.
- **Windows service install/uninstall** (`main.rs`): SCM registration is a TODO
  stub; no-op with a message off Windows.
