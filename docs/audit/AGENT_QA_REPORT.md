# Agent QA Report

Stack: Rust endpoint agent (`agent-rust/`). 8 findings.

## Gate results (final, re-verified from clean slate)

| Gate | Baseline | Final |
|------|----------|-------|
| `cargo fmt` | clean | clean |
| `cargo clippy --all-targets -- -D warnings` | clean | clean |
| `cargo test` | 33 tests | **44 tests** (+11) |

## Reliability rewrite (the headline)

The unattended service loop was rewritten so a single bad event can no longer take the agent offline. Three defects that each turned a transient condition into a dead-but-"online" device were fixed together:

1. **Session-start no longer crashes the service.** The entire start sequence is now a fallible inner async block; on error it logs, tears down any partially-built state, and `continue`s the loop instead of propagating out of `main`.
2. **Signaling reconnect with backoff.** `connect_agent` + `run_session_loop` are wrapped in an outer reconnect loop with capped exponential backoff + jitter, so a WS drop re-dials instead of exiting. This removes the "zombie" device (heartbeat kept refreshing Redis presence while the agent could no longer receive `session-control:start`).
3. **Duplicate-start teardown.** A second `start` without an intervening `end` now runs the full teardown of the prior session before building the new one — no leaked flush task, reporter, or peer connection.

---

## FIXED

- [HIGH] **A failed or hostile session-start crashed the entire unattended service.** `src/main.rs:254`. Every fallible step in the `start` arm used `?`, so a transient `PeerSession::new`/`create_offer`/`banner::show` failure propagated out of `run_session_loop` → `run_service` → `main` and exited the process; in service mode one bad start killed the agent permanently. **Fix:** fallible inner block with teardown + `continue` (see reliability rewrite).
- [MEDIUM] **Dropped signaling WebSocket permanently terminated the service (no reconnect).** `src/main.rs:140`. `connect_agent` was called once; when the pump ended, the loop returned `Ok(())` and the process stopped serving sessions while heartbeat kept the device "online." **Fix:** reconnect loop with capped exp backoff + jitter for the `keep_alive` path; portable/attended keep one-shot behavior.
- [MEDIUM] **Duplicate `session-control:start` leaked the prior session's flush task, reporter, and peer.** `src/main.rs:280`. The `start` arm overwrote `flush_task`/`reporter`/`peer`/`sess`/`_banner_handle` without tearing down an active session — the old `JoinHandle` dropped without abort, the old reporter without a final flush, the old `PeerSession` without `close()`. **Fix:** teardown-before-rebuild at the top of the `start` arm.
- [MEDIUM] **Consent banner never showed the real technician identity.** `src/main.rs:147`/`:212`. Both entry points passed a hardcoded literal `"Technician"`. **Fix (cross-stack B+A):** the backend's `session-control:start` payload gained `technician_name`; the agent parses it into `SessionControlPayload` and passes it to `banner::show`, failing closed to `"Unknown technician"` when absent. (Also in `SECURITY_AUDIT.md`.)
- [LOW] **Heartbeat always reported "idle".** `src/heartbeat.rs:70`. `run_loop` hardcoded `"idle"` on every tick, so a device heartbeated idle during an active session. **Fix:** a shared atomic status flag between the session loop and heartbeat reports in-session vs. idle.
- [LOW] **`reqwest::Client::new()` panics if the TLS backend fails to init.** `src/enroll.rs:38` (+ `heartbeat.rs:65`, `main.rs:181`, `audit_report.rs:47`). **Fix:** clients built via `reqwest::Client::builder().build()?` and the error propagated (no panic on rustls init failure).
- [LOW] **Chunk base64 fully decoded before the 4 MiB cap; `on_offer` overwrote files / leaked handles on duplicate id.** `src/file.rs:208`. An oversized chunk allocated the full decoded buffer before rejection (memory-amplification); a duplicate active offer id replaced an in-flight `Inbound` and dropped its open file. **Fix:** reject on the **encoded** length before decoding; reject a file-offer whose id is already active. (Also in `SECURITY_AUDIT.md`.)
- [INFO] **Missing tests** (`src/config.rs:103` representative): no coverage for `Config::resolve` precedence, `ice_servers_from_env`, `input::apply`, or session transitions out of `Ended`. **Fix:** +11 tests — config precedence/defaults, ICE env parse (valid array / single string / invalid-JSON→empty), `input::apply` on allowed + rejected events, illegal session transitions from `Ended`, and the dup/oversized file-chunk rejections.

---

## DOCUMENTED

- [MEDIUM] **Synchronous `std::fs` file I/O on the async runtime inside the data-channel handler.** `src/file.rs:218`. `FileReceiver::on_offer/on_chunk/on_complete` run blocking `std::fs` calls (up to 4 MiB writes) from the WebRTC `on_message` callback on a tokio worker thread, stalling the executor under a slow disk or concurrent transfers. **Remediation (post-MVP):** move the receiver's writes off the async threads via `tokio::task::spawn_blocking` (or a dedicated blocking thread fed by a channel). Accepted for MVP on the assumption of fast local disks; documented so it is not forgotten.
