# Architecture — Remote Support MVP

## 1. Purpose and framing

A Windows-first, attended + unattended remote-support platform for MSP
technicians, in the safe subset of tools like ScreenConnect / Supremo.

Non-negotiable properties, enforced by design:

- **Consent + visibility.** Attended sessions require the end user to enter a
  one-time code. Every session displays a visible banner on the controlled
  machine. There is **no hidden / silent / backstage mode**.
- **Auditability.** Every session lifecycle event and sensitive data action
  writes an append-only audit record.
- **No remote code execution.** The product streams screen + relays
  input/clipboard/file. It has **no terminal, PowerShell, SYSTEM shell, or
  remote script execution** surface, by design.

## 2. Components

```
 ┌──────────────┐      HTTPS/REST + WSS        ┌───────────────────┐
 │ Web console  │ ───────────────────────────▶ │  Backend (Go)     │
 │ Next.js/TS   │ ◀─────────────────────────── │  api + signaling  │
 └──────┬───────┘         signaling            └───┬──────────┬────┘
        │                                          │          │
        │  WebRTC (media + data channels)          │          │
        │  peer-to-peer, TURN-relayed when needed  │          │
        ▼                                          ▼          ▼
 ┌──────────────┐                             ┌────────┐  ┌────────┐
 │ Rust agent   │ ── REST enroll/heartbeat ──▶│Postgres│  │ Redis  │
 │ (Windows)    │ ── WSS /ws/agent signaling ─│(state, │  │(presence│
 │ svc+portable │                             │ audit) │  │ +codes)│
 └──────┬───────┘                             └────────┘  └────────┘
        │  WebRTC to console peer
        ▼
 ┌──────────────┐
 │   coturn     │  STUN/TURN relay (config external, env-driven)
 └──────────────┘
```

### 2.1 Backend (Go)
- HTTP REST API (`net/http` + chi router) and a WebSocket signaling hub.
- Postgres for durable state (technicians, devices, sessions, audit).
- Redis/Valkey for presence keys (TTL heartbeat) and hashed session codes (TTL).
- Stateless w.r.t. auth (JWT) so it can scale horizontally; the signaling hub is
  single-instance for the MVP (documented limitation, see ROADMAP).
- Layers: `httpapi` (handlers) → `service` (domain logic) → `store` (Postgres) +
  `cache` (Redis). `audit` is a cross-cutting service. `signal` is the WS hub.

### 2.2 Agent (Rust)
- Two run modes from one binary:
  - **Service (unattended):** installs as a Windows service, enrolls once with a
    device identity, heartbeats presence, waits for `session-control:start`.
  - **Portable (attended):** run by the end user, prompts for a session code,
    redeems it, then joins the session.
- Modules: `config`, `enroll`, `heartbeat`, `signal` (WS client), `banner`
  (mandatory visible consent UI), `webrtc`, `capture` (screen), `input`
  (injection), `clipboard`, `file`. Platform-sensitive modules (`capture`,
  `input`, `banner`, Windows-service glue) are `#[cfg(windows)]`; on non-Windows
  they compile to explicit `unimplemented!()`-guarded stubs so `cargo check`
  passes on the CI host. Real capture/input/WebRTC media are **TODO stubs with
  defined interfaces**, not fake implementations.

### 2.3 Web console (Next.js / TypeScript / Tailwind)
- App Router. Pages: `/login`, `/dashboard`, `/devices`, `/sessions/[id]`
  (WebRTC viewer + input capture), `/audit`.
- A typed API client mirrors `docs/API.md`. JWT held in memory + httpOnly-ish
  cookie fallback (MVP uses a client-stored token; hardening noted in ROADMAP).
- WebRTC viewer: receives the agent's video track, opens `input`/`clipboard`/
  `file` data channels, renders the mandatory "you are being viewed" indicator.

### 2.4 Relay (coturn)
- STUN for candidate discovery, TURN for relay when P2P fails (NAT/firewall).
- Config lives outside the app image (`infra/coturn/turnserver.conf`), secrets
  via env. The backend returns an `ice_servers` list to both peers.

## 3. Key flows

### 3.1 Unattended session
1. Agent (service) enrolls once → stores device token (DPAPI on Windows).
2. Agent heartbeats every 15s → Redis presence key (TTL 30s) → device shows
   **online** in the console.
3. Technician opens device, clicks **Start session** → `POST /sessions`.
4. Backend creates `pending` session, pushes `session-control:start` to the
   agent over `/ws/agent`, returns ICE servers to the console.
5. Agent shows the **banner**, acks `banner:visible` → session becomes `active`.
6. Peers exchange offer/answer/ICE via the backend signaling hub, then connect
   WebRTC directly (or via TURN). Media + data channels flow peer-to-peer.
7. Either side ends → `POST /sessions/{id}/end` → both peers notified, audit
   `session.end`.

### 3.2 Attended session
1. Technician `POST /attended/codes` → one-time code (e.g. `482-193-7`), read to
   the end user.
2. End user runs the portable agent, enters the code → `POST /attended/join`.
3. Backend validates + burns the code (single-use), creates an ephemeral
   attended device + binds it to the session, returns an ephemeral device token
   and ICE servers, audit `session.approve` (code entry = consent).
4. From step 5 of 3.1 onward, identical (banner, signaling, media).

## 4. Data model (Postgres)

```
technicians(id pk, email uniq, password_hash, display_name, role, created_at)
devices(id pk, name, hostname, os, device_secret_hash, mode, app_version,
        last_seen_at, created_at)                       -- mode: unattended|attended
sessions(id pk, device_id fk, technician_id fk, type, status,
         banner_visible bool, started_at, ended_at, created_at)
                                                         -- status: pending|active|ended
audit_events(id pk, event_type, session_id fk?, technician_id fk?, device_id fk?,
             metadata jsonb, created_at)                -- append-only
```
Presence and session codes are **not** in Postgres:
- Presence: Redis key `presence:device:{id}` = last status, TTL 30s.
- Session codes: Redis key `sessioncode:{sha256(code)}` = `{session_id}`, TTL 300s,
  deleted on redemption (single-use).

## 5. Trust boundaries

- **Browser ↔ backend:** untrusted client; JWT-authenticated; CORS-restricted.
- **Agent ↔ backend:** device-token-authenticated; enrollment gated by a shared
  token (MVP) that should become per-tenant (ROADMAP).
- **Peer ↔ peer (WebRTC):** DTLS-SRTP encrypted by WebRTC itself. Input/clipboard/
  file data channels are DTLS-encrypted. The agent never executes peer-supplied
  paths or commands; file writes are confined to a fixed downloads directory.
- **Backend ↔ Postgres/Redis:** private network (compose), credentials via env.

## 6. Signed-update readiness (not implemented)

The agent carries an `app_version` and a `TODO` update module with a defined
interface: check manifest → verify signature against a pinned public key →
download → verify → swap. No signing keys or update server exist in the MVP; the
interface and threat notes are in place so signing can be added without
rearchitecting. See `docs/ROADMAP.md`.

## 7. Deployment

Docker Compose only for the MVP: `postgres`, `redis`, `coturn`, `backend`,
`web-console`. The agent is built and run on Windows endpoints separately.
