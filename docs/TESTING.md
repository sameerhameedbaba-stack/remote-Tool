# Testing

How to run every automated suite for the Remote Support MVP, what each covers, and — honestly — what cannot be automated in this environment.

## Quick start

```bash
make test          # full suite   -> bash test/run-all.sh
make test-quick    # skip browser E2E -> bash test/run-all.sh --quick
make smoke-test    # seconds       -> boot backend, check health/auth/self-probe
make bench         # performance benchmarks (rate limiter)

# or directly:
bash test/run-all.sh
bash test/run-all.sh --quick
bash test/smoke.sh
```

A full mapping of every test **category** (smoke, unit, integration, API, E2E,
connection-stability, reconnect, remote-input, screen-streaming, RBAC, auth,
security, regression, performance, installer) to the concrete tests that cover
it — and an honest list of what is Windows-manual-only — is in
[`audit/TEST_COVERAGE_MATRIX.md`](audit/TEST_COVERAGE_MATRIX.md).

Everything runs on **local binaries — no Docker daemon required.** The integration suite provisions its own Postgres + Redis via `test/lib/provision.sh`; the E2E suites launch a real backend, a real Rust agent, and a headless browser peer.

## The six suites

| # | Suite | Command | What it covers |
|---|-------|---------|----------------|
| 1 | Rust agent unit | `cd agent-rust && cargo test` | 45 tests: config precedence, ICE env parse, `input::apply`, session-state transitions, file-chunk validation, reconnect backoff (capped/jittered) |
| 2 | Go backend unit | `cd backend-go && go test ./...` | service (ownership/allowlist/sanitize), auth, ratelimit, config, signal — no infra needed |
| 3 | Web console build | `cd web-console && npm run build` | production build, 11 routes, `tsc` type-check |
| 4 | Go backend integration | `cd backend-go && go test -tags=integration ./internal/integration/...` (real PG+Redis) | 20 tests: enrollment, presence online→offline + status filter, session lifecycle + `session.end` audit/idempotency, attended code single-use/TTL, `/agent/events` sanitization, GET /devices/{id} + /sessions, malformed-UUID→400, TOCTOU unique index, **token-realm isolation (RBAC)**, **SQL-injection-safe search** |
| 5 | E2E WebRTC | `bash test/run-e2e.sh` | real backend + real Rust agent + browser peer: 3 data channels + all 6 audit event types (`session.request/start/end`, `file.transfer`, `clipboard.sync`, `input.command_attempt`) |
| 6 | Console UI E2E | `bash test/run-console-e2e.sh` | real backend + browser: 6 console flows |

Suites 5 and 6 are skipped by `--quick`.

## Web console unit tests (Vitest)

```bash
cd web-console && npm run test      # 48 tests / 8 files
```
Covers the pure, high-value utilities: file-safety executable detection (`isDangerous`), API error mapping (`errorMessage`/`isNetworkError`), signaling envelope parsing, format/time helpers, favorites round-trip, `input-mapping` coordinate math, `cn`.

## Per-stack lint / typecheck / format

```bash
make lint        # cargo clippy -D warnings + go vet + eslint (--max-warnings=0)
make typecheck   # cargo check + go build + tsc --noEmit
make format      # cargo fmt + gofmt -w + eslint --fix
```

## Local-binary provisioning (no Docker daemon)

`test/run-all.sh` and the E2E drivers do **not** require the Docker daemon. `test/lib/provision.sh` (`provision_up`/`provision_down`) brings up the Postgres + Redis the integration suite needs and tears them down after; the backend applies migrations itself on boot. This keeps the suite runnable in constrained CI/sandbox environments.

## What CANNOT be automated here (honest limits)

The endpoint agent is Windows-first, and its OS-specific surfaces are **documented stubs** with defined interfaces (see `REPO_AUDIT.md` — none is a hidden mock; every stub announces itself and emits no fake data). The following require a real Windows host and are therefore **not** exercised by any suite in this repo:

- **Real screen capture** — the WebRTC screen media track is a stub (`agent-rust/src/webrtc.rs` `attach_screen_track` logs that it adds no track and no fake frames). The E2E WebRTC suite exercises the data channels and signaling, not real captured video.
- **OS input injection** — `agent-rust/src/input.rs` validates and audits input events but the actual injection is a `#[cfg(windows)]` stub; `input::apply` is unit-tested up to (not including) the OS call.
- **Native banner window** — the cross-platform console banner is tested; the native Windows banner window is a stub.
- **DPAPI token storage** — Windows DPAPI-backed device-token storage is a stub; off Windows a dev-only file fallback is used and must never ship.

Everything above the OS boundary — signaling, session lifecycle, consent/banner state machine, audit persistence + sanitization, file-transfer protocol framing, auth, rate limiting — **is** covered by suites 1–6.
