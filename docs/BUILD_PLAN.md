# Build Plan — Remote Support MVP

How the repository is built and in what order, for both local development and
the Docker Compose stack.

## 1. Prerequisites

| Tool           | Version used to verify | Needed for            |
|----------------|------------------------|-----------------------|
| Go             | 1.24.x                 | backend               |
| Rust / Cargo   | 1.94.x                 | agent                 |
| Node.js / npm  | 22.x / 10.x            | web console           |
| Docker + Compose | Docker 29, Compose v5 | full stack            |
| Postgres       | 16 (via compose)       | backend runtime       |
| Redis/Valkey   | 8 (via compose)        | presence + codes      |
| coturn         | 4.6 (via compose)      | TURN/STUN relay       |

## 2. Component build order

The three components are independent and can be built in parallel. Only runtime
(not build) has ordering: Postgres + Redis must be up before the backend serves.

### 2.1 Backend (Go)
```
cd backend-go
go build ./...        # compile everything
go vet ./...          # static checks
go test ./...         # unit tests (session codes, argon2, token parsing)
go run ./cmd/server   # run locally (needs DATABASE_URL + REDIS_URL + JWT_SECRET)
```
Migrations run automatically on boot (embedded migrator, idempotent). A seed
technician is created from `SEED_TECH_EMAIL`/`SEED_TECH_PASSWORD` if set and the
table is empty.

### 2.2 Agent (Rust)
```
cd agent-rust
cargo fmt --check
cargo check           # MUST pass on Linux CI (Windows code is cfg-gated)
cargo clippy
cargo test            # sanitization, allowlist, state machine, serde round-trips
# Windows target build (on a Windows host or cross toolchain):
# cargo build --release --target x86_64-pc-windows-msvc
```
Windows-only modules (capture, input, DPAPI, service, native banner) compile to
guarded stubs on non-Windows so CI stays green.

### 2.3 Web console (Next.js)
```
cd web-console
npm install
npm run build         # production build MUST succeed (TypeScript strict)
npm run dev           # local dev server on :3000
```

## 3. Full stack (Docker Compose)

```
cd infra
cp ../.env.example ./.env      # then edit — set real JWT_SECRET, passwords, tokens
docker compose config         # validate the compose file + env interpolation
docker compose up --build      # postgres, redis, coturn, backend, web-console
```
- Backend on `http://localhost:8080`, console on `http://localhost:3000`.
- coturn STUN/TURN on `3478` (udp/tcp) with a relay port range.
- The Windows agent is NOT part of compose; build and run it on the endpoint.

## 4. Configuration surface

All configuration is environment-driven; see `.env.example` for the complete
list. The backend refuses to start if `JWT_SECRET` is shorter than 32 bytes, or
(outside `APP_ENV=dev`) if a placeholder `change-me` secret is detected.

## 5. Verification gates (definition of "builds")

A change is considered building when all of these pass:
1. `cd backend-go && go build ./... && go vet ./... && go test ./...`
2. `cd agent-rust && cargo check && cargo test`
3. `cd web-console && npm run build`
4. `cd infra && docker compose config`

See `docs/TEST_PLAN.md` for functional verification beyond compilation.

## 6. Signed-update readiness (not built)

The agent includes an `update` module interface (manifest → verify signature vs
pinned key → download → verify → swap) but no signing keys, update server, or
CI signing step exist yet. Adding real signing is scoped in `docs/ROADMAP.md`
and requires no rearchitecting of the agent.
