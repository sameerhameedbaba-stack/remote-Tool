# Test Coverage Matrix

Maps every requested test category to the concrete tests that cover it, honestly.
Three states:

- **Covered** — real automated tests exist and pass in CI / `make test`.
- **Added this pass** — new tests written to close a gap found while auditing.
- **Windows-manual** — genuinely cannot be automated on this Linux host because
  it exercises the Windows-only data plane (screen capture, OS input injection,
  service installer). These are documented stubs, not hidden gaps; a manual
  checklist is given at the bottom.

Run everything: `make test` (or `bash test/run-all.sh`). Fast subset:
`make smoke-test`, `make test-quick`. Benchmarks: `make bench`.

| # | Category | Status | Where |
|---|----------|--------|-------|
| 1 | Smoke | **Added this pass** | `test/smoke.sh` (`make smoke-test`): builds+boots the real backend, asserts `/healthz` 200, `/readyz` 200 (real DB+Redis ping), a protected route → 401, and the binary `-healthcheck` self-probe. |
| 2 | Unit | Covered | Rust **45** (`cargo test`): config precedence, ICE env parse, input apply/validate, session state machine, file path/dup/oversize, banner, token store, reconnect backoff. Go: `auth`, `config`, `ratelimit`, `service` (sanitize + event allowlist), `signal`. Web **48** (`vitest`): file-safety, api error mapping, signaling parse, input-mapping letterbox math, session-connect, format, favorites, cn. |
| 3 | Integration | Covered | `backend-go/internal/integration/*` (real Postgres+Redis, `-tags=integration`, **20 tests**): full lifecycle, presence, audit, signaling handshake + buffering + isolation, reconnect-resume, plus the items added below. |
| 4 | API | Covered | The integration suite exercises every HTTP route and its status codes: `auth/login`, `agent/enroll` (+429 on bad-token flood), `agent/heartbeat`, `agent/events` (sanitized), `devices` + `devices/{id}` (200/404/401/400), `sessions` CRUD + `end`, `attended/codes` + `join` (single-use, TTL expiry), `audit` (filter + keyset pagination). |
| 5 | E2E | Covered | `test/run-e2e.sh` — real backend + **real Rust agent** + headless browser peer: 3 data channels + all 6 audit event types. `test/run-console-e2e.sh` — 6 real browser UI flows (login, dashboard, attended code, devices, audit, session banner). |
| 6 | Connection stability | Covered | `TestSignalingFullHandshake`, `TestSignalingBuffersOfferForLateTech` (offer survives a late technician), signaling session isolation, and a live `RTCPeerConnection` reaching `connected` with all channels in the WebRTC E2E. Long-duration media soak is Windows-manual (needs real capture). |
| 7 | Reconnect | **Added this pass** | Rust `reconnect_backoff_is_capped_and_monotonic` (1→2→4→8→16→30s cap, bounded jitter, de-sync). Backend `TestAgentReconnectResumesPendingStart`: agent WS drop → reconnect → a pending session-start is redelivered. |
| 8 | Remote input | Covered | Rust `input::apply`/`validate` (OS event allowlist; rejects disallowed key/mouse). Web `normalizedCoords` letterbox/crop content-box math + button/modifier mapping (vitest). Actual `SendInput` OS injection is Windows-manual. |
| 9 | Screen streaming | **Windows-manual** | The console negotiates a `recvonly` video transceiver and the E2E drives the media/data path, but real DXGI screen capture only runs on Windows (documented stub in `agent-rust/src/capture.rs`). See manual checklist. |
| 10 | RBAC / authorization | **Added this pass** | `TestTokenRealmIsolation`: a device token is rejected on every technician route and a technician JWT is rejected on every device route (the two auth realms are isolated). `TestAuthEnforcement`: no-token/bad-token/valid-token. Fine-grained admin-vs-technician RBAC is deferred in the single-tenant MVP (see `SECURITY_AUDIT.md`). |
| 11 | Authentication | Covered | `TestLoginBadCredentials`, `TestLoginRateLimit`, JWT parse/expiry (`auth` unit), device-token verify (`TestEnrollmentAndDeviceAuth`), enrollment-token constant-time compare + failed-attempt limiter. |
| 12 | Security | Covered | `TestDeviceSearchInjectionSafe` (SQLi payloads treated as literals; table integrity checked), metadata whitelist/`sanitizeEventMetadata` (drops clipboard text / keystroke content), path traversal + Windows reserved names (`sanitize_filename`), HMAC session codes, malformed-UUID → 400, CSP/X-Frame-Options headers, secrets `json:"-"`. Prior review: `../../SECURITY_REVIEW.md`. |
| 13 | Regression | Covered | Every fixed defect this pass shipped with a test that fails without the fix (session.end audited+idempotent, presence online→offline, UUID 400s, enroll limiter, sanitization, letterbox coords, etc.). CI runs the whole suite on every push, so these are permanent regression guards. |
| 14 | Performance | **Added this pass** | `BenchmarkAllowHotKey` / `BenchmarkAllowAtCapacity` (`make bench`) prove the rate limiter stays fast (~0.2µs hot, ~5µs at the 50k-key ceiling — bounded, not O(n)). Enforced pagination caps in the API tests; keyset audit pagination. Full load/soak testing is future work. |
| 15 | Installer | **Windows-manual** | The Windows service install/uninstall path is a documented stub (`agent-rust` service mode); it cannot run on Linux. See manual checklist. |

## Windows-manual checklist (cannot run on this Linux host)

These require a real Windows endpoint and are the honest boundary of what CI here
can prove. They are tracked in `docs/ROADMAP.md`.

**Screen streaming**
1. Build the agent on Windows; run in service mode; start an unattended session.
2. Confirm the technician sees live desktop video (DXGI capture publishes a track).
3. Confirm frame rate/latency are acceptable and the stream recovers after a
   monitor/resolution change.

**Remote input (OS injection)**
1. From the console, move the mouse and type; confirm `SendInput` drives the real
   cursor/keyboard on the Windows host.
2. Confirm the input allowlist blocks anything outside mouse/keyboard events.

**Installer**
1. Run the service installer; confirm the service registers, starts on boot, and
   runs as the intended account.
2. Confirm uninstall removes the service and its stored DPAPI token cleanly.
3. Confirm the consent banner window renders natively and is non-dismissible.
