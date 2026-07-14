# Remote Support MVP

A production-shaped, Windows-first remote-support platform for MSP technicians —
the safe subset of a ScreenConnect / Supremo-style tool. It supports **attended**
(one-time code) and **unattended** (installed service) sessions, streams the
endpoint screen and relays input / clipboard / file over WebRTC, and is built so
the **security model is the product**: explicit consent, a mandatory visible
banner, a full audit trail, device-identity auth, and short-lived single-use
session codes.

By design it has **no terminal, PowerShell, SYSTEM shell, or remote-script
execution**, and **no hidden / silent / backstage session mode**.

- Agent: **Rust** (Windows service + portable). Backend: **Go**. Console:
  **Next.js + TypeScript + Tailwind**. DB: **Postgres**. Presence/codes:
  **Redis/Valkey**. Relay: **coturn**. Deploy: **Docker Compose**.
- The authoritative cross-component contract lives in
  [`docs/API.md`](docs/API.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
  and [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md).

---

## 1. What works (built, and verified in this build)

All four build gates pass on the build host (Go 1.24.7, Cargo 1.94, Node 22,
Docker Compose v5):

- **Go backend** — `go build ./...`, `go vet ./...`, `gofmt -l .`, and
  `go test ./...` all pass. Fully implemented: technician auth (argon2id +
  HS256 JWT), device enrollment + device-token auth, presence heartbeats
  (Redis TTL), unattended session creation, attended one-time session codes
  (CSPRNG, hash-stored, single-use, auto-expiring), WebSocket signaling relay
  with **banner-gated activation** and per-session party checks, audit logging
  over a closed event set with cursor pagination, embedded idempotent Postgres
  migrations, a first-boot seed technician, and config guards that refuse weak
  or placeholder secrets. The backend subagent additionally exercised it live
  against real Postgres + Redis (login, enroll, heartbeat presence flip,
  session create, attended code burn, WS banner→active transition,
  foreign-session envelope drop).
- **Rust agent** — `cargo check` clean and **32 unit tests pass**. Real:
  service + portable modes, enrollment, heartbeat, WS signaling client, the
  banner-gated session state machine, WebRTC peer/data-channel wiring, and the
  security-critical validation (file-name sanitization, input allowlist +
  coordinate bounds, text-only clipboard).
- **Next.js console** — `npm run build` passes clean with TypeScript strict and
  no `any` in the client. Pages: login, dashboard (attended-code creation with
  expiry countdown), devices (presence polling + connect), session viewer
  (WebRTC **answerer**, receives track + data channels, sends input/clipboard/
  file, shows a non-dismissible active-session banner), audit (filters + cursor
  pagination).
- **Infra** — `docker compose config` validates the full stack (Postgres,
  Valkey, coturn, backend, console) with env-only secrets and external coturn
  config.

The end-to-end signaling handshake is defined and each side is unit/contract
level correct, with the **agent as the WebRTC offerer** and the **console as the
answerer** (see [`docs/API.md`](docs/API.md) §Signaling).

**Automated tests (all pass; run `bash test/run-all.sh`).** Rust agent unit tests
(`cargo test`), Go backend unit tests, a Go **integration** suite against real
Postgres + Redis (every endpoint, auth/authz, single-use codes, rate limits,
`/agent/events` sanitization, the WebSocket signaling handshake, offer buffering,
audit), the console production build, a **true end-to-end WebRTC test** (real
backend + the real Rust agent + a headless-browser peer establishing a live
peer connection with data channels and asserting the audit events), and a
**console UI E2E** (Playwright driving login, devices, audit, and the session
banner). CI runs all of it (`.github/workflows/ci.yml`). See
[`docs/TEST_PLAN.md`](docs/TEST_PLAN.md) and [`test/README.md`](test/README.md).
The only things not automated require a Windows host (screen capture, input
injection, native banner, DPAPI) — see §2/§3.

## 2. Windows data plane — implemented, compile-verified, runtime-pending

The remote-control internals are now **implemented for Windows** and
**compile-checked for `x86_64-pc-windows-gnu`** from the Linux dev host (via a
mingw cross-check), plus packaged into a downloadable installer by the
[Windows agent CI](.github/workflows/windows-agent.yml). Their *runtime*
behavior must be confirmed on a real Windows machine — that is what the
installer is for (see [`installer/README.md`](installer/README.md)).

- **Screen capture** (`agent-rust/src/capture.rs`) — real GDI `BitBlt` of the
  primary display → BGRA frame. (DXGI is a future perf optimization.)
- **Screen streaming** (`agent-rust/src/encode.rs`, `webrtc.rs`) — JPEG-encoded
  frames chunked over a `screen` data channel; the console decodes them to a
  canvas. **The full encode→chunk→channel→decode pipeline is verified end-to-end
  on Linux CI** with a synthetic capture source (`decoded 1 frame at 320x240`).
- **Input injection** (`agent-rust/src/input.rs`) — real `SendInput` (mouse
  absolute move/click, keyboard VK up/down with modifier bracketing). Validation
  is real on all platforms.
- **Native banner window** (`agent-rust/src/banner.rs`) — real always-on-top,
  non-closable red Win32 bar naming the technician; the mandatory console banner
  is still emitted too, so visibility is never skipped.
- **DPAPI token storage** (`agent-rust/src/token_store.rs`) — real
  `CryptProtectData`; non-Windows uses a documented **insecure `0600` file
  fallback** for dev only.
- **Install / auto-start** (`agent-rust/src/main.rs`) — `install`/`uninstall`
  register a per-user HKCU `Run` auto-start (chosen over a session-0 service so
  capture has an interactive desktop).

Still stubbed (honestly, no fabricated data):

- **Clipboard OS get/set** (`agent-rust/src/clipboard.rs`) — Windows
  `CF_UNICODETEXT` not wired; **validation + audit are real**.
- **Signed auto-update** (`agent-rust/src/update.rs`) — interface + pinned-key
  verify flow defined; bodies `unimplemented!()` (manual updates for MVP).

## 3. What's unsafe / not production-ready

Honest list; none of these weaken the core guarantees (consent, banner, audit,
no RCE), and all are tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md):

- **No TLS in the box.** Compose serves plaintext HTTP/WS for localhost. Put a
  TLS terminator in front and force `wss://` before any real deployment.
- **Insecure dev token storage off Windows.** The non-Windows `token_store`
  fallback writes the device token to a `0600` file. Never ship it.
- **Single shared enrollment token**, not per-tenant/revocable.
- **JWTs are not revocable** mid-lifetime; the short TTL is the only mitigation.
- **Static TURN credentials** instead of short-lived TURN REST credentials.
- **Single-instance signaling hub** and **in-process rate limiter** — no
  horizontal scale yet.
- **Coarse authorization** — single tenant, all technicians equal.
- **Auto-update is unimplemented** (interface only); updates are manual and
  unsigned.

See [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) for the fresh-context review
findings and their dispositions, and
[`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md) for the guarantees and their
mechanisms.

## 4. How to run locally

Prereqs: Docker + Docker Compose.

```bash
# 1. Configure secrets (never commit the real .env)
cp .env.example infra/.env
#    edit infra/.env — set a >=32-byte JWT_SECRET and real passwords/tokens.
#    Keep APP_ENV=dev to allow localhost plaintext + relaxed placeholder checks.

# 2. Bring up Postgres, Valkey, coturn, backend, and console
cd infra
docker compose up --build
```

- Console: <http://localhost:3000>  ·  Backend API: <http://localhost:8080>
- Log in with the seeded technician (`SEED_TECH_EMAIL` / `SEED_TECH_PASSWORD`).
- coturn STUN/TURN listens on `3478` (udp/tcp) with a relay port range.

The Windows agent is **not** part of Compose; build and run it on the endpoint
(see [`agent-rust/README.md`](agent-rust/README.md)). On the Linux build host it
compiles and its logic is unit-tested, but capture/input are Windows stubs.

Component-local build/run instructions:
[backend](backend-go/README.md) · [agent](agent-rust/README.md) ·
[console](web-console/README.md).

A root [`Makefile`](Makefile) wraps the three toolchains:
`make install | build | test | smoke-test | lint | typecheck | format | clean`.
Operator runbook: [`docs/RUNBOOK.md`](docs/RUNBOOK.md); how to test everything:
[`docs/TESTING.md`](docs/TESTING.md).

### Engineering audit

A full engineering audit (repo, frontend, backend, agent, integration, security,
performance, devops, code quality) with the findings and their fixes lives in
[`docs/audit/`](docs/audit/) — start with
[`CTO_FINAL_REVIEW.md`](docs/audit/CTO_FINAL_REVIEW.md).

## 5. How to test an attended session

1. In the console, open **Dashboard → Start attended session**. A one-time code
   like `482-193-7` appears with a live expiry countdown. (Audited as
   `session.request`.)
2. On the end-user machine, run the portable agent and enter the code:
   ```bash
   remote-agent --api-base http://<backend-host>:8080 portable
   ```
3. The agent redeems the code (`POST /attended/join`), which is **single-use** —
   a second attempt with the same code fails. (Audited as `session.approve`.)
4. The end-user machine shows the **mandatory banner**; the session does not
   become `active` in the console until the agent acks `banner:visible`.
5. Signaling (offer/answer/ICE) completes; the console shows the active-session
   indicator and opens the input/clipboard/file data channels. (Screen video is
   stubbed — see §2.) End from either side → `session.end` audited.

## 6. How to test unattended registration

1. Enroll the device once (needs the shared enrollment token):
   ```bash
   REMOTE_AGENT_ENROLLMENT_TOKEN=<AGENT_ENROLLMENT_TOKEN> \
     remote-agent --api-base http://<backend-host>:8080 enroll --name FRONT-DESK-01
   ```
   This calls `POST /agent/enroll`, persists the device token, and audits
   `device.register`.
2. Run the agent in service mode:
   ```bash
   remote-agent --api-base http://<backend-host>:8080 service
   ```
   It heartbeats every 15s; within ~15s the device shows **online** in the
   console **Devices** page, and flips to **offline** ~30s after it stops
   (Redis presence TTL).
3. In the console, **Connect** to the online device → `POST /sessions` →
   `session.request`; the agent receives `session-control:start`, shows the
   banner, acks, and the session goes `active` (`session.start`).

(On Windows, `remote-agent install` registers the service so it runs
unattended at boot; this is a cfg-gated stub on non-Windows.)

## 7. Known risks

- **Dual-use tooling.** This is legitimate consented remote support, but remote
  screen + input control is inherently sensitive. The banner, consent, audit,
  and no-RCE boundaries are load-bearing safety controls — do not weaken them.
- **Plaintext transport in dev.** Without a TLS terminator, signaling and API
  traffic are unencrypted on the wire (WebRTC media/data channels are
  DTLS-encrypted regardless).
- **Shared enrollment token.** Anyone with it can enroll a device; rotate it and
  move to per-tenant tokens before scale.
- **Signaling scale.** The signaling hub is single-instance and in-memory
  (it now buffers the agent's offer for a not-yet-connected console, so the
  handshake is reliable, but it does not yet cluster across replicas).
- **Dev token fallback.** The non-Windows `0600` token file is insecure by
  design and must never ship.
- See [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) for the reviewed findings.

## 8. Next 10 implementation tasks

1. Terminate TLS for backend + console; force `wss://` signaling.
2. Implement Windows DXGI screen capture into the WebRTC video track.
3. Implement Windows `SendInput` behind the validated-input interface.
4. Build the always-on-top native Windows banner window.
5. Finish DPAPI device-token storage; drop the dev file fallback in release.
6. Implement the signed-update flow + Authenticode signing in CI.
7. Replace the shared enrollment token with per-tenant, revocable tokens.
8. Add JWT refresh + revocation.
9. Switch coturn to short-lived TURN REST credentials.
10. Add end-to-end integration tests for the attended + unattended flows.

---

## Repository layout

```
agent-rust/      Rust Windows agent (service + portable)
backend-go/      Go backend (REST API + WebSocket signaling)
web-console/     Next.js technician console
infra/           docker-compose.yml + coturn config
docs/            ARCHITECTURE, API, SECURITY_MODEL, BUILD_PLAN, TEST_PLAN, ROADMAP
SECURITY_REVIEW.md   Fresh-context security review findings + dispositions
.env.example     All configuration (secrets via env only)
```

## Security posture, in one paragraph

Every backend endpoint requires auth unless explicitly public; agents present a
device identity; attended access uses random, short-lived, single-use,
auto-expiring codes stored only as hashes; a session cannot go active without a
visible, non-suppressible banner; every session lifecycle transition and every
sensitive data action writes an append-only audit record; there is no code path
from remote input to command execution; and all secrets come from environment
variables (`.env` is git-ignored, only `.env.example` placeholders are
committed). Details and honest limitations are in
[`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md).
