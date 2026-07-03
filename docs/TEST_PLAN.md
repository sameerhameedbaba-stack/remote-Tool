# Test Plan — Remote Support MVP

Covers automated checks and manual functional verification. The MVP's security
model is the product, so the plan emphasizes auth, session codes, consent/banner,
and audit coverage.

## 0. Running the automated suites

One command runs everything (local binaries, no Docker daemon needed):

```
bash test/run-all.sh            # agent + backend unit + integration + console build + both E2E suites
bash test/run-all.sh --quick    # skip the two browser E2E suites
```

Individual suites:

```
cd agent-rust && cargo test                                   # 1. agent unit tests
cd backend-go && go test ./...                                # 2. backend unit tests
bash test/run-e2e.sh                                          # 5. end-to-end WebRTC test
bash test/run-console-e2e.sh                                  # 6. console UI E2E
# backend integration (provisions Postgres+Redis, build-tagged):
#   TEST_DATABASE_URL=... TEST_REDIS_URL=... go test -tags=integration ./internal/integration/...
```

CI runs all of this on every push (`.github/workflows/ci.yml`): a unit/build job,
an integration job against Postgres + Redis service containers, and a browser
E2E job.

**Automated coverage vs. Windows-only gaps.** Everything except the Windows-only
device internals is exercised by automated tests, including a real end-to-end
WebRTC session. What remains verifiable only on a Windows host — real screen
capture, OS input injection, the native banner window, and DPAPI token storage
(all documented stubs) — is called out in §4.

## 1. Automated tests

### Backend integration (Go, real Postgres + Redis) — `go test -tags=integration`
In-process wiring of the full service graph exercised over HTTP + WebSocket:
health/ready; login (good/bad); auth enforcement on protected endpoints;
enrollment + device-token auth (forged secret rejected); presence → online;
unattended session lifecycle (offline → 409, online → 201 + ICE); attended
one-time code single-use (200 then 404, malformed → 400); `/agent/events`
ingestion (202 owner, 403 non-owner, 400 bad type, 401 no token) with metadata
whitelisting proven via the audit query; audit filtering + cursor pagination;
login and `/attended/join` rate-limiting (429); the WebSocket signaling
handshake (session-control:start, banner-gated activation, offer/answer/ICE
relay, foreign-session isolation); and the offer-buffering race fix.

### End-to-end WebRTC (`test/run-e2e.sh`)
Real backend + the **real Rust agent** running in service mode on Linux + a
headless-browser technician peer. Enrolls, goes online, starts a session, acks
the mandatory banner, establishes a **live WebRTC peer connection** (ICE + data
channels) between Chromium and the agent, sends input/clipboard/file over the
data channels, and asserts the `input.command_attempt`, `clipboard.sync`, and
`file.transfer` audit events are persisted. This proves the entire platform path
except the Windows-only screen pixels and OS input injection.

### Console UI E2E (`test/run-console-e2e.sh`)
Playwright drives the **real Next.js console** against a real backend: login
(bad → error, good → dashboard), one-time attended-code creation, the devices
list showing an online device, the audit log, and the mandatory
"REMOTE SESSION ACTIVE" banner on the session screen.

### Backend (Go) — `go test ./...`
- Session-code generation: correct length, digits only, `ddd-ddd-d` format,
  drawn from a CSPRNG, hashed before storage.
- argon2id password/device-secret hash + verify round-trip; wrong secret fails.
- Device-token parsing (`<id>.<secret>`) and constant-time verification.
- JWT issue/verify: expiry enforced, tampered token rejected.
- Audit: `session.*` write failure fails the originating action.

### Agent (Rust) — `cargo test`
- File-name sanitization rejects `..`, absolute paths, and separators; keeps a
  safe basename; enforces the size cap.
- Input key-code allowlist rejects unknown/dangerous codes; normalized
  coordinate bounds `[0,1]` enforced.
- Session state machine cannot reach `active` without a banner ack.
- Signaling envelope serde round-trips for every message type.

### Web console (TypeScript) — `npm run build`
- Production build with TypeScript strict mode is the gate (no `any` in the API
  client). Type-level conformance to `docs/API.md` shapes.

## 2. Manual functional tests

Bring the stack up: `cd infra && docker compose up --build`. Log into the
console at `http://localhost:3000` with the seeded technician.

### T1 — Technician auth
1. Wrong password → `401`, and an `auth.login_failed` row appears in `/audit`.
2. Correct password → redirected to `/dashboard`; `auth.login` audited.
3. Hitting an API without a token → `401 unauthorized`.

### T2 — Unattended registration + presence
1. On a test host, enroll the agent:
   `remote-agent enroll` (with `REMOTE_AGENT_ENROLLMENT_TOKEN` set) → prints a
   device id and persists the device token; an audit `device.register` appears.
2. Run `remote-agent service`. Within ~15s the device shows **online** in
   `/devices`; stop it and within ~30s it flips to **offline** (presence TTL).

### T3 — Attended session via one-time code
1. In the console, click **Start attended session** → a code like `482-193-7`
   with a countdown appears; `session.request` (attended) audited.
2. On the end-user host, run `remote-agent portable`, enter the code.
3. Wrong/expired/reused code is rejected (`404/410/409`); a correct code is
   accepted exactly once; `session.approve` audited.
4. The end-user host shows the **mandatory banner**; the session does not go
   `active` in the console until the banner ack is received.

### T4 — Session lifecycle + signaling
1. From `/devices`, **Connect** to an online unattended device → navigates to
   `/sessions/[id]`; the agent receives `session-control:start`.
2. Signaling (offer/answer/ICE) completes; the console shows the live-session
   indicator; `session.start` audited. (Screen video is a documented stub — see
   Known Limitations; the data channels and signaling are exercised for real.)
3. Clipboard sync → `clipboard.sync` audited. File send → `file.transfer`
   audited. Remote input actions → `input.command_attempt` audited.
4. **End session** on either side → both peers notified, `session.end` audited,
   session shows `ended`.

### T5 — Consent / no-hidden-mode invariant
1. Confirm there is no flag, endpoint, or config that suppresses the banner.
2. Confirm the session state machine (agent + backend) blocks `active` until the
   banner is acknowledged.

### T6 — Audit completeness
1. Walk `/audit` and confirm every action in T1–T4 produced exactly one record
   with technician id, device id, session id, and timestamp as applicable.

### T7 — Secrets / config hardening
1. Start the backend with a short `JWT_SECRET` → it refuses to boot.
2. Start with a `change-me` secret and `APP_ENV` unset → it refuses to boot.
3. `git grep` for secrets finds only `.env.example` placeholders.

## 3. Security review

`SECURITY_REVIEW.md` is produced by a fresh-context reviewer checking for
hardcoded secrets, unsafe command paths, weak/guessable session codes, missing
auth, missing audit events, and insecure file paths. It must be re-run before
any release.

## 4. What is NOT covered (honest gaps — all require a Windows host or a lab)

The automated E2E now covers signaling, a live WebRTC peer connection, the data
channels, and the audit pipeline. What remains uncovered needs a Windows machine
or a multi-host network:

- Real screen-capture video (DXGI Desktop Duplication is a stubbed interface —
  the E2E establishes the media transport but the agent adds no video track yet).
- Real Windows input injection (the `SendInput` path is a stubbed interface; the
  E2E verifies the input **message** is received, validated, and audited, not
  that a keystroke is injected into Windows).
- The native always-on-top banner window and DPAPI token storage (Windows-only;
  the non-Windows banner + token fallback are what the E2E exercises).
- Cross-NAT TURN relaying under adverse networks (needs a multi-host test bed;
  the E2E connects over loopback host candidates).
- Load/scale of the single-instance signaling hub.

These are tracked in `docs/ROADMAP.md`.
