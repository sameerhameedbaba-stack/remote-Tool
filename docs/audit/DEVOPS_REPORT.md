# DevOps / Build Report

7 findings. All fixed this pass. `docker compose config` validates.

## Makefile target list

Root `Makefile` — one entry point across all three toolchains; CI runs the same underlying checks.

| Target | Does |
|--------|------|
| `help` (default) | list targets |
| `install` | `cargo fetch` + `go mod download` + `npm ci` |
| `build` | build all three stacks (`build-agent`/`build-backend`/`build-web`) |
| `test` | full suite → `bash test/run-all.sh` |
| `smoke-test` | fast smoke → `bash test/run-all.sh --quick` |
| `lint` | `cargo clippy -D warnings` + `go vet` + `npm run lint` |
| `typecheck` | `cargo check` + `go build` + `tsc --noEmit` |
| `format` | `cargo fmt` + `gofmt -w` + `eslint --fix` |
| `clean` | remove `target/`, `bin/`, `tmp/`, `.next/`, `out/`, `*.tsbuildinfo` |

---

## FIXED

- [HIGH] **`APP_ENV` missing from `.env.example` broke the documented backend-local run.** `.env.example`. `config.go` rejects any `change-me` secret unless `APP_ENV=="dev"`, but `.env.example` shipped every secret with a `change-me` placeholder and never defined `APP_ENV`; `cp .env.example .env && go run ./cmd/server` failed with `JWT_SECRET still contains a placeholder value`. The compose path only worked because it hardcodes `APP_ENV: ${APP_ENV:-dev}`. **Fix:** `APP_ENV=dev` added to `.env.example` with a comment explaining dev relaxes placeholder checks and unset/other = strict production validation.
- [MEDIUM] **`DATABASE_URL` duplicated `POSTGRES_PASSWORD` inline — silent auth-failure footgun.** `.env.example`. The password was copied literally into the DSN; a dev who changes `POSTGRES_PASSWORD` but not the embedded copy gets a backend that starts but fails Postgres auth with no obvious cause. **Fix:** a bold inline note added that the two must stay in sync (and that under compose the line can be deleted to let the interpolated default reuse `POSTGRES_PASSWORD`).
- [MEDIUM] **Missing `.dockerignore` for `backend-go` and `web-console`.** Both Dockerfiles do `COPY . .` and `.gitignore` is not honored by Docker — web copied local `node_modules`/`.next` over the clean deps-stage output and could bake a developer `.env` into an image layer; backend copied `.git` and stray `.env`. Bloat + secret-leak risk. **Fix:** `web-console/.dockerignore` (node_modules, .next, .env*, .git, npm-debug.log) and `backend-go/.dockerignore` (bin/, tmp/, .git, .env*); lockfiles/go.mod kept.
- [MEDIUM] **web-console had no ESLint config — `npm run lint` was a non-runnable trap and web lint was absent from CI.** `web-console/package.json`. `next lint` with no config drops into interactive setup (hangs in CI), so the one TS/React codebase handling auth tokens had zero lint coverage while Rust (clippy) and Go (vet) linted in CI. **Fix:** flat `eslint.config.mjs` (`next/core-web-vitals`), `next lint --max-warnings=0` script, and a web lint step added to CI. (Also in `SECURITY_AUDIT.md` and `FRONTEND_QA_REPORT.md`.)
- [MEDIUM] **No unified task runner.** `README.md`. Only web-console exposed dev/build/(broken)lint; tests were aggregated only by `test/run-all.sh`; no install/typecheck/format/clean/smoke-test and no root Makefile — a contributor had to know cargo, go, and npm per stack, and CI duplicated all of them inline. **Fix:** root `Makefile` (target list above); CI extended to run web lint + tsc + vitest + build.
- [LOW] **backend and web-console compose services had no healthcheck despite `/healthz` and `/readyz` existing.** `infra/docker-compose.yml`. Only postgres/redis had healthchecks; web's `depends_on: [backend]` waited only for container start, not readiness; and the backend image is distroless (no shell/curl), so a CMD-SHELL check won't work. **Fix:** backend healthcheck uses the binary's own self-probe `["CMD", "/server", "-healthcheck"]`; web-console uses a `node -e fetch(...)` one-liner; web now `depends_on: backend: {condition: service_healthy}`.
- [LOW] **backend README env-export mangled the `ICE_SERVERS` JSON.** `backend-go/README.md`. `export $(grep -v '^#' .env | xargs)` stripped the quotes from `ICE_SERVERS=["stun:...","turn:..."]`, exporting invalid JSON so `parseICEServers` failed and the backend refused to start — a second breaker in the same documented flow as `APP_ENV`. **Fix:** the recipe now uses `set -a; . ./.env; set +a`, which preserves quoted/JSON values verbatim.

## CI

`.github/workflows/ci.yml` now enforces the web stack (lint + tsc + vitest + build) alongside the existing Rust (clippy `-D warnings`) and Go (vet) gates. Backend healthcheck subcommand (`server -healthcheck`) supports the distroless compose healthcheck.

## DOCUMENTED

None among the seven — all fixed.
