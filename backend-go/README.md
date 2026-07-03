# Remote Support MVP — Go backend

REST API + WebSocket signaling server for the consented, audited, banner-enforced
remote-support MVP. It implements the contract in
[`docs/API.md`](../docs/API.md), [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md),
and [`docs/SECURITY_MODEL.md`](../docs/SECURITY_MODEL.md).

- Language: Go 1.24, module `github.com/remote-support/backend`
- Router: chi · DB: Postgres (pgx) · Cache: Redis · WS: coder/websocket
- Layers: `httpapi` → `service` → `store` (Postgres) + `cache` (Redis);
  cross-cutting `audit`; in-memory `signal` hub.

## Run

The backend reads all configuration from environment variables (names match
[`.env.example`](../.env.example)). It needs a reachable Postgres and Redis.

```sh
# from the repo root
cp .env.example .env        # then fill in real secrets (APP_ENV=dev is preset)
set -a; . ./.env; set +a    # sources .env verbatim — preserves the quoted
                            # ICE_SERVERS JSON (xargs would corrupt it)
cd backend-go
go run ./cmd/server
```

On boot the server: loads + validates config, applies SQL migrations
(idempotent, tracked in `schema_migrations`), seeds the technician from
`SEED_TECH_EMAIL`/`SEED_TECH_PASSWORD` if the table is empty, then listens on
`BACKEND_HTTP_ADDR` (default `:8080`).

Config safety: it refuses to start if `JWT_SECRET` < 32 bytes, or if any secret
still contains `change-me` — unless `APP_ENV=dev`.

### Build / test / lint

```sh
cd backend-go
go build ./...
go vet ./...
gofmt -l .
go test ./...
```

### Docker

```sh
docker build -t remote-support-backend ./backend-go
```

Multi-stage build producing a distroless, non-root image exposing 8080.

## Environment variables

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres DSN (required) |
| `REDIS_URL` | Redis URL for presence + session codes (required) |
| `BACKEND_HTTP_ADDR` | Bind address (default `:8080`) |
| `JWT_SECRET` | HS256 signing key, ≥ 32 bytes (required) |
| `JWT_TTL` | Access-token lifetime (default `3600s`) |
| `AGENT_ENROLLMENT_TOKEN` | Shared token gating `/agent/enroll` (required) |
| `SESSION_CODE_TTL` | Attended-code lifetime (default `300s`) |
| `SESSION_CODE_LENGTH` | Attended-code digit count (default `9`) |
| `CORS_ALLOWED_ORIGIN` | Console origin allowed by CORS + WS |
| `SEED_TECH_EMAIL` / `SEED_TECH_PASSWORD` | First-boot seed technician (optional) |
| `TURN_USER` / `TURN_PASSWORD` / `TURN_REALM` | Long-term TURN creds |
| `ICE_SERVERS` | JSON array of ICE URL strings returned to peers |
| `APP_ENV` | `dev` relaxes placeholder-secret validation |

## Endpoints

Base prefix `/api/v1` unless noted. Auth: **T** = technician JWT
(`Authorization: Bearer <jwt>`), **D** = device token
(`Authorization: Bearer <device_id>.<secret>`), **P** = public.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/healthz` | P | Liveness |
| GET | `/readyz` | P | Readiness (pings DB + Redis) |
| POST | `/api/v1/auth/login` | P | Technician login → JWT |
| GET | `/api/v1/me` | T | Current technician |
| GET | `/api/v1/devices` | T | List devices (presence-derived status) |
| GET | `/api/v1/devices/{id}` | T | Single device |
| POST | `/api/v1/sessions` | T | Start unattended session (online device) |
| GET | `/api/v1/sessions` | T | List sessions |
| GET | `/api/v1/sessions/{id}` | T | Single session |
| POST | `/api/v1/sessions/{id}/end` | T | End a session |
| POST | `/api/v1/attended/codes` | T | Create one-time attended code |
| POST | `/api/v1/attended/join` | P | Redeem attended code (rate-limited per IP) |
| POST | `/api/v1/agent/enroll` | P* | Enroll unattended device (enrollment-token gated) |
| POST | `/api/v1/agent/heartbeat` | D | Presence heartbeat |
| GET | `/api/v1/audit` | T | Query audit events (filters + cursor) |
| GET | `/ws/signal?session_id=` | T | Technician signaling socket (JWT via `?token=` or header) |
| GET | `/ws/agent` | D | Agent signaling socket |

All non-2xx responses use the envelope `{"error":{"code","message"}}`.

## Signaling

The hub relays only `offer`/`answer`/`ice-candidate`/`session-control`/`banner`
JSON envelopes between the two peers of a session; media and data channels are
peer-to-peer (WebRTC, TURN-relayed when needed) and never traverse the backend.
A session becomes `active` only after the agent acknowledges `banner:visible` —
there is no hidden mode. The hub is single-instance for the MVP.

## MVP scope notes

See `docs/SECURITY_MODEL.md §8` for documented limitations (single shared
enrollment token, non-revocable JWTs, single-instance hub, in-process rate
limiter, static TURN creds, coarse authz).
