# Tests

Automated test suites for the Remote Support MVP. Everything runs on local
binaries — **no Docker daemon required** (Postgres and Redis are started from
local binaries by `test/lib/provision.sh`).

## Run everything

```bash
bash test/run-all.sh            # all suites
bash test/run-all.sh --quick    # skip the two browser E2E suites
```

## Suites

| Suite | Command | What it covers |
|-------|---------|----------------|
| Agent unit | `cd agent-rust && cargo test` | filename sanitization, input allowlist, session state machine, serde, etc. |
| Backend unit | `cd backend-go && go test ./...` | argon2, JWT, session codes, rate limiter, signaling hub |
| Backend integration | `go test -tags=integration ./internal/integration/...` (needs `TEST_DATABASE_URL` + `TEST_REDIS_URL`) | every REST endpoint, auth/authz, single-use codes, rate limits, `/agent/events` sanitization, the WebSocket signaling handshake, offer buffering, audit |
| End-to-end WebRTC | `bash test/run-e2e.sh` | real backend + real Rust agent + headless-browser peer → live WebRTC data channels + audit events |
| Console UI E2E | `bash test/run-console-e2e.sh` | Playwright drives the real console: login, attended code, devices, audit, session banner |

## Layout

```
test/
  run-all.sh            one-command runner + summary
  run-e2e.sh            end-to-end WebRTC test (backend + agent + browser)
  run-console-e2e.sh    console UI E2E (backend + console + browser)
  lib/provision.sh      start/stop local Postgres + Redis
  e2e/
    run.mjs             WebRTC E2E driver (Playwright)
    answerer.html       browser "technician" WebRTC peer (answerer)
    console-e2e.mjs     console UI E2E driver (Playwright)
    package.json        Playwright dependency
```

## Browser

The E2E drivers use Playwright. They pick a Chromium binary in this order:
`CHROME_PATH` → the sandbox's pre-installed `/opt/pw-browsers/chromium-1194`
→ Playwright's own bundled browser (installed via `npx playwright install
chromium`, as CI does).

## Not covered here

Real Windows screen capture, OS input injection, the native banner window, and
DPAPI token storage require a Windows host and are documented stubs. See
`docs/TEST_PLAN.md` §4.
