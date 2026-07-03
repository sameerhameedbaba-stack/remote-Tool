# Integration & E2E Test Report

Covers the cross-stack test suites, the flow-coverage matrix, the six integration findings, and the one integration failure that was found and fixed during this pass.

## Single-command runner

`test/run-all.sh` is the one entry point. Everything runs on **local binaries — no Docker daemon required**; Postgres + Redis are provisioned by `test/lib/provision.sh` for the integration suite.

```
bash test/run-all.sh            # run every suite
bash test/run-all.sh --quick    # skip the two browser E2E suites
make test                       # -> run-all.sh
make smoke-test                 # -> run-all.sh --quick
```

## The six suites and their results (final)

| # | Suite | Command | Result |
|---|-------|---------|--------|
| 1 | Rust agent unit | `cargo test` | PASS — **44 tests** |
| 2 | Go backend unit | `go test ./...` | PASS (+ new service/auth/ratelimit tests) |
| 3 | Web console build | `npm run build` | PASS — 11 routes |
| 4 | Go backend integration | `go test -tags=integration` (real Postgres+Redis) | PASS — **18 tests** (+5), incl. migration `0002` |
| 5 | E2E WebRTC | `test/run-e2e.sh` (backend + real Rust agent + browser peer) | PASS — 3 data channels + all 6 audit event types |
| 6 | Console UI E2E | `test/run-console-e2e.sh` (backend + console + browser) | PASS — 6 flows |

Suites 5 and 6 are skipped by `--quick`. The E2E WebRTC run asserts all three data channels and all six audit event types end-to-end: `session.request`, `session.start`, `session.end`, `file.transfer`, `clipboard.sync`, `input.command_attempt`.

## The integration failure that was found and fixed (be honest: it failed first)

While fixing the `/agent/enroll` rate-limit security finding, the agent's first implementation limited **all** enrollment attempts per source IP. That broke the integration suite: the tests enroll several devices in a burst from one host (localhost), tripped the limiter, and started getting 429s — a **real** integration failure, surfaced by the suite, not mocked or silenced.

The fix was to limit **only failed (bad-token)** attempts and audit `device.register_failed`. This throttles token brute-force without penalizing legitimate bulk enrollment. The suite then went green. This is the intended behavior of the runner: a real defect was caught and corrected rather than suppressed.

## Flow coverage matrix

Legend: ✅ covered before this pass · ➕ added this pass · 🪟 manual / Windows-only (documented stub, cannot be automated here).

| Flow | Status | Notes |
|------|--------|-------|
| Enrollment + device auth | ✅ | `TestEnrollmentAndDeviceAuth` |
| Presence online (heartbeat) | ✅ | online direction asserted |
| Presence online→offline + `?status=` filter + 400 | ➕ | new test drives the transition and the list filter |
| `GET /devices/{id}` (200/404/401) | ➕ | was zero coverage |
| `GET /sessions` (list) | ➕ | was never called |
| Unattended session lifecycle | ✅ | create → activate → end |
| `session.start` audited | ✅ | `signaling_test.go` |
| `session.end` audited + idempotent | ➕ | HIGH finding: was asserted nowhere |
| Attended code single-use + malformed length | ✅ | |
| Attended code TTL expiry | ➕ | forces expiry rather than relying on reuse |
| `/agent/events` file.transfer sanitization | ✅ | secret_field dropped |
| `/agent/events` clipboard.sync + input.command_attempt sanitization | ➕ | text/content dropped; previously only in fragile E2E, skipped by `--quick` |
| Malformed UUID id/filter → 400 | ➕ | |
| CreateUnattended TOCTOU (partial unique idx) | ➕ | migration `0002` |
| E2E WebRTC: 3 channels + 6 audit events | ✅ | `run-e2e.sh` |
| Console UI: 6 flows | ✅ | `run-console-e2e.sh` |
| Real Windows screen capture / input injection / native banner / DPAPI | 🪟 | documented stubs — cannot be automated off Windows (see `docs/TESTING.md`) |

---

## FIXED (the six findings)

- [HIGH] **`session.end` audit event never asserted.** `internal/integration/api_test.go:122`. Sessions were ended 5× but only HTTP 200 was checked; `TestAuditFilteringAndPagination:227` deliberately omitted `session.end` (and `session.start`). A regression moving/losing the `au.Log(EventSessionEnd)` call would pass green. **Fix:** assert `auditHas(t, sid, "session.end")` after `/end`; add `session.end` to the expected-types list.
- [MEDIUM] **clipboard.sync + input.command_attempt sanitization covered only by the fragile browser E2E (skipped under `--quick`).** `api_test.go:158`. The content-bearing events where leakage matters most were verified only by the heaviest suite. **Fix:** `TestAgentEventsIngestAndSanitization` extended to POST both types with injected `text`/`content` and assert only whitelisted keys persist.
- [MEDIUM] **online→offline presence transition and `?status=` filter untested.** `api_test.go:54`. Only the online direction was asserted. **Fix:** new test enrolls+heartbeats (online), deletes the presence key via `app.cache`, asserts offline + `?status=offline`/`online` inclusion/exclusion + `?status=bogus`→400.
- [MEDIUM] **`GET /devices/{id}` had zero coverage.** `handlers_devices.go:28`. Console device-detail depends on it. **Fix:** 200 (right id + status), 404 (random uuid), 401 (no token).
- [LOW] **`GET /sessions` never called by any test.** `handlers_sessions.go`. **Fix:** after creating a session, assert 200 + id present; 401 without a token.
- [LOW] **Attended-code TTL expiry untested.** `api_test.go:127`. GETDEL made expiry indistinguishable from consumption. **Fix:** create a code, force-expire its Redis key, POST `/attended/join` → 404 — locking in that codes are stored with an expiry.

## DOCUMENTED

None among the six — all fixed. The Windows-only surfaces (screen capture, input injection, native banner, DPAPI) remain out of automated reach here and are documented as stubs in `docs/TESTING.md`.
