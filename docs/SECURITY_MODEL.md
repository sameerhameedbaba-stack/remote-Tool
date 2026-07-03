# Security Model — Remote Support MVP

This document states the security properties the MVP guarantees, the mechanisms
that enforce them, and the honest list of what is **not** yet production-grade.
It is the reference the security review (`SECURITY_REVIEW.md`) checks against.

## 1. Security requirements (hard, from the spec)

| # | Requirement | Mechanism |
|---|-------------|-----------|
| 1 | All backend APIs require auth unless explicitly public | Auth middleware; only `/healthz`, `/readyz`, `/auth/login`, `/agent/enroll`, `/attended/join` are public, and the last two are gated by a secret token / one-time code |
| 2 | Agent registration uses a device identity | Enrollment issues `device_id` + `device_secret`; only the argon2id hash of the secret is stored; every agent call presents the device token |
| 3 | Session codes: random, short-lived, single-use, auto-expiring | CSPRNG digits; stored as `sha256(code)`→session in Redis with TTL; deleted on first redemption |
| 4 | Every session writes audit records | Audit service writes `session.request/approve/start/end` plus `file.transfer`, `clipboard.sync`, `input.command_attempt` |
| 5 | Visible end-user banner; no hidden session | Session cannot become `active` until the agent acks `banner:visible`; banner module is mandatory, non-suppressible |
| 6 | No plaintext passwords; no hardcoded secrets | argon2id for technician + device secrets; all secrets via env vars; `.env` git-ignored; `.env.example` holds only placeholders |
| 7 | Architecture prepared for signed updates | Agent update module interface + pinned-key verification design (not implemented) |

## 2. Authentication & authorization

### Technicians
- Login with email + password. Passwords hashed with **argon2id**
  (memory-hard, per-password salt). No plaintext, no reversible storage.
- On success, a short-lived **JWT (HS256)** is issued (`JWT_TTL`, default 1h),
  signed with `JWT_SECRET` (>=32 bytes, env-only). Claims: `sub`, `email`,
  `role`, `iat`, `exp`.
- Every non-public endpoint requires a valid, unexpired JWT. Expired/invalid →
  `401 unauthorized`.
- `POST /auth/login` is rate-limited per source IP, and the "unknown email"
  branch performs an equivalent argon2id verification against a fixed dummy hash
  so login timing does not reveal which emails exist (defeats user enumeration).
- Authorization for the MVP is coarse: any authenticated technician may act on
  any device/session in the single-tenant deployment. Multi-tenant scoping is
  ROADMAP.

### Agents / devices
- **Enrollment** (`/agent/enroll`) is gated by `AGENT_ENROLLMENT_TOKEN` (env).
  A correct token yields a device identity: `device_id` + high-entropy
  `device_secret` (32 bytes CSPRNG). Backend stores only `argon2id(device_secret)`.
- The agent presents `Authorization: Bearer <device_id>.<device_secret>` on
  every subsequent call; the backend looks up the device and verifies the secret
  against the stored hash in constant time.
- The device token is returned exactly once and stored by the agent under
  Windows DPAPI (`CryptProtectData`, current-user or machine scope for the
  service). Loss of the token requires re-enrollment.

## 3. Session codes (attended)

- Generated with a CSPRNG, `SESSION_CODE_LENGTH` digits (default 9 → 10^9
  space), formatted for reading (`ddd-ddd-d`).
- Stored only as a **keyed HMAC-SHA256(code)** in Redis (keyed with a
  server-side secret), mapped to the session id, with TTL `SESSION_CODE_TTL`
  (default 300s). Using a keyed HMAC rather than a bare hash means a Redis leak
  alone cannot brute-force the low-entropy numeric codes offline — the attacker
  also needs the server secret.
- **Single-use:** redemption deletes the key atomically; a second attempt fails.
- **Rate limiting:** `/attended/join` is rate-limited per source IP to blunt
  brute force; combined with short TTL and single-use this keeps the effective
  guess probability negligible. The limiter key is the **real socket peer IP**;
  `X-Forwarded-For` is deliberately **not** trusted (it is client-controlled and
  would let an attacker rotate the key). The bucket map is size-bounded with idle
  eviction. (MVP uses an in-process limiter; a shared, trusted-proxy-aware
  limiter is ROADMAP.)

## 4. Audit trail

- Append-only `audit_events` table; the app never issues UPDATE/DELETE on it.
- Closed set of event types (see `docs/API.md`).
- Lifecycle events (`session.*`) are written **before** the action is
  acknowledged; if the audit write fails, the action fails. Specifically,
  `session.start` is written before the session is flipped active, and the agent
  WS handler treats an activation error as fatal (it ends the session), so a
  session can never be active-yet-unaudited.
- The three data-channel events (`file.transfer`, `clipboard.sync`,
  `input.command_attempt`) occur peer-to-peer where the backend cannot see them,
  so the **agent reports them** to `POST /agent/events` (device-authenticated).
  `input.command_attempt` is aggregated into a periodic **count** so no keystroke
  content is recorded. These are best-effort-durable (retried then logged).
- Records capture technician id, device id, session id, event type, and a
  minimal, server-whitelisted metadata blob (e.g. source IP, file name/size,
  clipboard direction/length, input count). No screen contents, keystroke
  contents, or clipboard contents are stored in the audit trail — only that the
  action happened. The backend discards any non-whitelisted metadata field.

## 5. Transport & media security

- REST + signaling should run over TLS in any real deployment (compose ships
  plaintext for localhost; put the backend behind a TLS terminator — ROADMAP).
- WebRTC media and all data channels are **DTLS-SRTP / DTLS** encrypted by the
  WebRTC stack itself, peer-to-peer. The backend never sees media or data-channel
  contents — it relays only SDP/ICE.
- TURN relays ciphertext only; coturn credentials are env-supplied. The MVP uses
  static long-term TURN credentials; production should use time-limited TURN REST
  credentials (`turn_rest_api`) — ROADMAP.

## 6. Input / file / clipboard safety

- The agent treats all peer data as untrusted:
  - **Input:** normalized coordinates + a fixed key-code allowlist; the agent
    injects OS input events only, never shell commands. There is no code path
    from a data-channel message to process execution.
  - **File:** the peer-supplied file name is sanitized (basename only, no path
    separators, no traversal, no drive/UNC prefix) and, additionally, Windows
    reserved DOS device names (`CON`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, …)
    are rejected so they cannot escape to a device on Windows. Files are written
    **only** into a fixed downloads directory. Size caps apply.
  - **Clipboard:** text only; no HTML/RTF/file-list clipboard formats.

## 7. Secrets handling

- All secrets (`JWT_SECRET`, DB/Redis creds, `AGENT_ENROLLMENT_TOKEN`, TURN
  creds) are read from environment variables. None are compiled in.
- `.env` is git-ignored; only `.env.example` (placeholders) is committed.
- The backend refuses to start if `JWT_SECRET` is shorter than 32 bytes or if a
  placeholder value (`change-me...`) is detected in a non-dev profile.

## 8. Known security limitations (MVP — see ROADMAP)

1. Single shared enrollment token instead of per-tenant, revocable tokens.
2. JWT is not refreshable/revocable mid-lifetime; short TTL is the mitigation.
3. Signaling hub is single-instance; no clustered fan-out.
4. TLS termination is out-of-image (operator responsibility) rather than built in.
5. Static TURN credentials rather than short-lived REST credentials.
6. Coarse authz (single tenant, all technicians equal).
7. Signed auto-update is designed but not implemented — updates are manual.
8. Rate limiting is in-process, not shared across replicas.
9. The console passes the technician JWT (and the agent its device token) as a
   WebSocket URL query parameter (`?token=`), since browsers cannot set
   `Authorization` on a WebSocket handshake. URLs are more prone to landing in
   proxy/access logs than headers. Mitigations: short JWT TTL and origin-checked
   upgrades; the planned fix is a single-use short-TTL WebSocket ticket minted by
   an authenticated HTTP endpoint (ROADMAP).

None of these are silent: each is documented and none weakens the core
guarantees (consent, visible banner, audit, no RCE).
