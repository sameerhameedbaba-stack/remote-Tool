# API Contract — Remote Support MVP

This is the **authoritative contract** shared by the Go backend, the Rust agent,
and the Next.js console. All three components must conform to it exactly.

- Base URL (dev): `http://localhost:8080`
- All request/response bodies are JSON (`Content-Type: application/json`).
- API version prefix: `/api/v1`.
- All timestamps are RFC 3339 UTC strings.
- All IDs are UUID v4 strings unless noted.

## Authentication

Two principal types, two credential types:

| Principal   | Credential                        | Header                              |
|-------------|-----------------------------------|-------------------------------------|
| Technician  | JWT access token (HS256)          | `Authorization: Bearer <jwt>`       |
| Agent/Device| Device token (opaque, per-device) | `Authorization: Bearer <device_tok>`|

- Technician JWT claims: `sub` (technician id), `email`, `role`, `exp`, `iat`.
- Device token is issued at enrollment and presented by the agent on every call.
  It is `"<device_id>.<device_secret>"`; the backend looks up the device and
  verifies `device_secret` against the stored argon2id hash.

Endpoints are **authenticated by default**. Only endpoints explicitly marked
**PUBLIC** may be called without a credential.

### Error envelope

Non-2xx responses use:

```json
{ "error": { "code": "string_code", "message": "human readable" } }
```

Common codes: `unauthorized`, `forbidden`, `not_found`, `invalid_request`,
`conflict`, `expired`, `rate_limited`, `internal`.

---

## Health

### `GET /healthz` — **PUBLIC**
Liveness. `200 {"status":"ok"}`.

### `GET /readyz` — **PUBLIC**
Readiness (DB + Redis reachable). `200 {"status":"ready"}` or `503`.

---

## Technician auth

### `POST /api/v1/auth/login` — **PUBLIC**
Request:
```json
{ "email": "admin@example.com", "password": "..." }
```
Response `200`:
```json
{ "token": "<jwt>", "expires_at": "2026-07-03T18:00:00Z",
  "technician": { "id": "...", "email": "...", "display_name": "...", "role": "admin" } }
```
`401 unauthorized` on bad credentials. Writes audit event `auth.login`
(success) — failed logins are logged as `auth.login_failed`.

### `GET /api/v1/me` — technician
Returns the current technician object.

---

## Devices (technician)

### `GET /api/v1/devices`
Query params: `status` (`online|offline`, optional), `q` (name search, optional).
Response `200`:
```json
{ "devices": [
  { "id": "...", "name": "FRONT-DESK-01", "hostname": "front-desk-01",
    "os": "windows", "mode": "unattended", "status": "online",
    "last_seen_at": "2026-07-03T17:59:00Z", "created_at": "..." }
] }
```
`status` is derived from presence: `online` if a heartbeat was seen within the
presence TTL (30s), else `offline`.

### `GET /api/v1/devices/{id}`
Single device object (same shape as list element). `404 not_found` if unknown.

---

## Sessions (technician)

### `POST /api/v1/sessions`
Start an **unattended** session against a registered, online device.
Request:
```json
{ "device_id": "..." }
```
Response `201`:
```json
{ "session": { "id": "...", "device_id": "...", "technician_id": "...",
    "type": "unattended", "status": "pending", "created_at": "..." },
  "ice_servers": [ { "urls": "stun:coturn:3478" },
                   { "urls": "turn:coturn:3478", "username": "turnuser", "credential": "..." } ] }
```
Backend notifies the target agent over its signaling channel. Writes audit
`session.request`. `409 conflict` if device offline or already in a session.

### `POST /api/v1/attended/codes`
Create a **one-time attended session code**. The technician reads this code to
the end user, who types it into the portable agent.
Request:
```json
{ "label": "Jane's laptop" }
```
Response `201`:
```json
{ "code": "482-193-7", "session_id": "...", "expires_at": "2026-07-03T18:05:00Z" }
```
- Code is random, `SESSION_CODE_LENGTH` digits (default 9), single-use,
  auto-expiring (`SESSION_CODE_TTL`, default 300s).
- Only a hash of the code is stored; the plaintext is returned once.
- Writes audit `session.request` (type attended).

### `GET /api/v1/sessions`
List sessions (most recent first). Query: `status`, `device_id`, `limit` (<=100).

### `GET /api/v1/sessions/{id}`
Single session object.

### `POST /api/v1/sessions/{id}/end`
End an active/pending session. Notifies both peers. Writes audit `session.end`.
Response `200` with the updated session.

---

## Agent endpoints (device token, except enroll)

### `POST /api/v1/agent/enroll` — **PUBLIC (enrollment-token gated)**
Register a new **unattended** device. Requires the shared enrollment token.
Request:
```json
{ "enrollment_token": "...", "name": "FRONT-DESK-01",
  "hostname": "front-desk-01", "os": "windows" }
```
Response `201`:
```json
{ "device_id": "...", "device_token": "<device_id>.<device_secret>",
  "poll_interval_seconds": 15 }
```
- The `device_token` is shown **once**; the agent persists it locally
  (DPAPI-protected on Windows — see agent docs). Backend stores only the
  argon2id hash of `device_secret`.
- Writes audit `device.register`.

### `POST /api/v1/agent/heartbeat` — device
Presence heartbeat. Request:
```json
{ "status": "idle", "app_version": "0.1.0" }
```
Response `200 {"ok":true, "presence_ttl_seconds":30}`. Backend refreshes the
device's presence key in Redis (TTL 30s) and updates `last_seen_at`.

### `POST /api/v1/attended/join` — **PUBLIC (session-code gated)**
Portable agent redeems an attended session code. Request:
```json
{ "code": "482-193-7", "hostname": "jane-laptop", "os": "windows" }
```
Response `200`:
```json
{ "session_id": "...", "device_token": "<ephemeral_device_id>.<secret>",
  "ice_servers": [ ... ] }
```
- Validates code (exists, not expired, not used). Marks it used (single-use).
- Creates an ephemeral device row (`mode="attended"`) bound to the session.
- Writes audit `session.approve` (the end user, by entering the code, consents).
- `410 expired` / `404 not_found` / `409 conflict` (already used).

---

## Signaling (WebSocket)

WebRTC signaling is relayed by the backend. Media and input/clipboard/file
data channels flow **peer-to-peer** (via TURN when needed), never through the
backend. The backend only relays SDP + ICE + session-control envelopes.

### `GET /ws/signal?session_id={id}` — technician (JWT via `?token=` or header)
### `GET /ws/agent` — device (device token via header)

Both sockets exchange newline-free JSON envelopes:

```json
{ "type": "offer|answer|ice-candidate|session-control|banner|error",
  "session_id": "...", "payload": { } }
```

- `offer` / `answer`: `payload` is the RTCSessionDescription (`{type, sdp}`).
- `ice-candidate`: `payload` is an RTCIceCandidateInit.
- `session-control`: `payload.action` in `start|end|approve`. Server→agent
  `start` tells the agent to display the **banner** and begin capture.
- `banner`: agent→server acknowledgement `{"visible":true}`; server records it.
  A session may not enter `active` until the agent confirms the banner is
  visible. There is no hidden/silent mode.
- The server authenticates each socket, binds it to the session, and relays
  envelopes to the opposite peer. It drops any envelope whose `session_id` the
  principal is not a party to.

### Data-channel protocol (peer-to-peer, defined here for both ends)

Three labeled `RTCDataChannel`s. All messages are JSON except file chunks.

- Channel `input` (technician→agent): keyboard/mouse events.
  ```json
  { "t": "mouse", "x": 0.5, "y": 0.33, "button": "left", "action": "down" }
  { "t": "key", "code": "KeyA", "action": "down", "modifiers": ["ctrl"] }
  ```
  Every distinct remote-control action the agent *receives* is audited as
  `input.command_attempt` (sampled/aggregated — see SECURITY_MODEL). x/y are
  normalized [0,1] fractions of the streamed surface.
- Channel `clipboard` (bidirectional): text only.
  ```json
  { "t": "clipboard", "direction": "to-agent|to-tech", "text": "..." }
  ```
  Each sync writes audit `clipboard.sync`.
- Channel `file` (bidirectional): simple chunked transfer.
  ```json
  { "t": "file-offer", "id": "...", "name": "notes.txt", "size": 1234, "direction": "to-agent" }
  { "t": "file-accept", "id": "..." }
  { "t": "file-chunk", "id": "...", "seq": 0, "data": "<base64>" }
  { "t": "file-complete", "id": "..." }
  ```
  Each completed transfer writes audit `file.transfer`. No path is taken from
  the peer; the agent writes only into a fixed downloads directory.

---

## Audit (technician)

### `GET /api/v1/audit`
Query: `session_id`, `device_id`, `technician_id`, `event_type`, `since`,
`until`, `limit` (<=200, default 50), `cursor` (opaque).
Response `200`:
```json
{ "events": [
  { "id": "...", "event_type": "session.start", "session_id": "...",
    "technician_id": "...", "device_id": "...",
    "metadata": { "ip": "..." }, "created_at": "..." }
], "next_cursor": null }
```

### Audit event types (closed set)
`auth.login`, `auth.login_failed`, `device.register`, `session.request`,
`session.approve`, `session.start`, `session.end`, `file.transfer`,
`clipboard.sync`, `input.command_attempt`.

Every session lifecycle transition and every sensitive data action produces
exactly one audit record. Audit writes are best-effort-durable: a failed audit
write fails the originating action for lifecycle events (`session.*`), and is
retried-then-logged for high-volume data events.
