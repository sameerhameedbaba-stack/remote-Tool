# Operator Runbook

Bring up, operate, and troubleshoot the Remote Support MVP (Go backend + signaling, Postgres, Redis/Valkey, coturn, Next.js console). The Windows agent runs separately on each endpoint.

## Prerequisites

- Docker + Docker Compose (for the server-side stack).
- Ports: `8080` (backend/signaling), `3000` (console), `3478/udp+tcp` and `49160-49200/udp` (coturn).
- The Windows agent is built and run on the endpoint separately (`agent-rust/README.md`).

## Environment setup

```bash
cp .env.example .env      # then edit values
```

Fill in real secrets — `.env` is git-ignored; never commit it. Key variables (`.env.example` documents all of them):

- **`APP_ENV`** — `dev` relaxes the placeholder-secret checks so the `change-me` defaults boot locally. **Leave it unset (or non-`dev`) in production** — the backend then refuses to start with any `change-me` placeholder.
- **`JWT_SECRET`** — HS256 signing key, must be ≥ 32 bytes; rotate per deploy.
- **`AGENT_ENROLLMENT_TOKEN`** — shared token an operator gives an agent to enroll a new unattended device (single value for MVP).
- **`POSTGRES_PASSWORD` / `DATABASE_URL`** — the password inside `DATABASE_URL` must match `POSTGRES_PASSWORD`. Under compose you can delete the `DATABASE_URL` line to let it derive the DSN automatically. **Changing one but not the other = backend starts but fails Postgres auth.**
- **`SESSION_CODE_TTL` / `SESSION_CODE_LENGTH`** — attended-code lifetime/length.
- **`SEED_TECH_EMAIL` / `SEED_TECH_PASSWORD`** — seed technician created on first boot if the technicians table is empty; blank disables seeding.
- **`ICE_SERVERS`** — JSON array of STUN/TURN URLs handed to peers; **keep the quotes** (it is JSON). If sourcing `.env` in a shell, use `set -a; . ./.env; set +a` — `export $(... | xargs)` strips the quotes and breaks the JSON.
- **`TURN_*`**, **`CORS_ALLOWED_ORIGIN`**, **`NEXT_PUBLIC_*`** — TURN creds, console origin, browser-exposed API/WS base URLs.

## Bring up

```bash
cd infra
docker compose up --build
```

Brings up Postgres, Redis/Valkey, coturn, the backend, and the console. Postgres/Redis start first (healthchecked); the backend waits for them healthy; the console waits for the backend **service_healthy** (its distroless healthcheck runs `/server -healthcheck`).

**Migrations auto-run on boot.** On startup the backend applies all pending `backend-go/migrations/*.up.sql` in lexical order, each in its own transaction, recording applied versions in `schema_migrations` (`store.Migrate`, called from `cmd/server/main.go`). No manual migration step. Current migrations: `0001_init`, `0002_session_and_device_indexes`.

## Health endpoints

- **`GET /healthz`** — liveness (process up).
- **`GET /readyz`** — readiness: pings Postgres + Redis; returns non-200 until dependencies are reachable.
- **`server -healthcheck`** — the binary's own in-process probe of local `/healthz`; used as the compose healthcheck because the distroless image has no shell/curl.

## Seed a technician

Set `SEED_TECH_EMAIL` + `SEED_TECH_PASSWORD` before first boot; the backend creates that technician if the technicians table is empty. Log in at the console (`http://localhost:3000`) or `POST /api/v1/auth/login`. Login is rate-limited per source IP.

## Enroll an agent (unattended device)

Give the agent the `AGENT_ENROLLMENT_TOKEN`; it `POST`s `/api/v1/agent/enroll` and receives a device token it stores (DPAPI on Windows). The device then heartbeats (`/api/v1/agent/heartbeat`) every 15s, which sets a Redis presence key (TTL 30s) → the device shows **online** in the console. Note: only **failed** (bad-token) enroll attempts are rate-limited and audited (`device.register_failed`); legitimate bulk enrollment is not throttled.

## Create a session

- **Unattended** — technician clicks Connect on an online device in the console (`POST /api/v1/sessions`). The backend pushes `session-control:start` (now carrying `technician_name`) to the agent over `/ws/agent`; the agent shows the mandatory consent banner with the real technician identity, and the session only becomes `Active` after the agent acks `banner:{visible:true}`. There is no silent/hidden-session path.
- **Attended** — technician issues a one-time code (`POST /api/v1/attended/codes`, HMAC-hashed, TTL `SESSION_CODE_TTL`); the end user runs the agent and enters it (`POST /api/v1/attended/join`, rate-limited, single-use). Same banner/consent gate applies.

The technician's browser connects the media/data channels over `/ws/signal` (which enforces that the connecting technician owns the session).

## Where the audit lives

Append-only `audit_events` table in Postgres. Every lifecycle and data-channel action is recorded: `auth.login`, `device.register` (+ `device.register_failed`), `session.request/approve/start/end`, and the device-reported `file.transfer` / `clipboard.sync` / `input.command_attempt` (metadata is server-side whitelisted — **no keystroke or clipboard content is stored**). Read via `GET /api/v1/audit` (technician JWT) with keyset pagination and session/device/technician filters. In the single-tenant MVP any technician can read the full log (documented tradeoff — see `docs/audit/SECURITY_AUDIT.md`).

## Backup basics

- **Postgres** is the system of record (technicians, devices, sessions, audit). Back it up with `pg_dump` / a volume snapshot of `pgdata`. The audit table is append-only — treat it as the compliance record.
- **Redis/Valkey** holds only ephemeral presence keys and short-lived session codes; it is intentionally non-persistent (`--save "" --appendonly no`) and does **not** need backup — it rebuilds from live heartbeats.

## Known operational limits (MVP)

Documented in `docs/SECURITY_MODEL.md` / `docs/ROADMAP.md` and `../SECURITY_REVIEW.md`:

- **No TLS in the box** — the operator terminates TLS in front; dev is localhost plaintext.
- **Single shared enrollment token**; JWTs are not revocable mid-TTL (short TTL mitigates).
- **Single-instance signaling hub** and an in-process (not shared) rate limiter — scale-out is post-MVP.
- **Static TURN credentials**; **coarse single-tenant authorization** (all technicians trusted; RBAC/multi-tenant is roadmap).
- **WS auth token in the URL query** — browsers can't set `Authorization` on a WS handshake; mitigated by short JWT TTL + origin checks; single-use WS ticket is planned.
- **Windows-only agent surfaces** (screen capture, input injection, native banner, DPAPI) are the real product on Windows; off-Windows builds use documented dev-only stubs that must never ship.
