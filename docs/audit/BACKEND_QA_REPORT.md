# Backend QA Report

Stack: Go API + WebSocket signaling (`backend-go/`). 9 findings.

## Gate results (final, re-verified from clean slate)

| Gate | Baseline | Final |
|------|----------|-------|
| `gofmt` | clean | clean |
| `go vet ./...` | clean | clean |
| `go build ./...` | ok | ok |
| Unit tests | auth/ratelimit/config/signal only | + new `service/`, `auth/`, `ratelimit/` unit tests |
| Integration tests | 13 | **18** (+5), incl. migration `0002` |

Integration suite runs against a real Postgres + Redis provisioned by `test/lib/provision.sh` (see `INTEGRATION_TEST_REPORT.md`).

## Route / auth matrix

Every non-public route is behind auth. Confirmed in `internal/httpapi/server.go`.

| Route | Method | Guard |
|-------|--------|-------|
| `/healthz`, `/readyz` | GET | public (health) |
| `/api/v1/auth/login` | POST | public + `loginLimiter` (per source IP) |
| `/api/v1/agent/enroll` | POST | public + shared-token compare + `enrollLimiter` on failed attempts |
| `/api/v1/attended/join` | POST | public + `joinLimiter` (per source IP) |
| `/api/v1/me` | GET | `requireTech` |
| `/api/v1/devices`, `/devices/{id}` | GET | `requireTech` |
| `/api/v1/sessions` | POST/GET | `requireTech` |
| `/api/v1/sessions/{id}`, `/{id}/end` | GET/POST | `requireTech` |
| `/api/v1/attended/codes` | POST | `requireTech` |
| `/api/v1/audit` | GET | `requireTech` |
| `/api/v1/agent/heartbeat`, `/agent/events` | POST | `requireDevice` (device token) |
| `/ws/signal`, `/ws/agent` | GET | **in-handler** JWT / device-token auth |

The two WebSocket routes authenticate inside the handler (browsers cannot set `Authorization` on a WS handshake). The signaling WS was hardened this pass to also enforce operator identity (below).

Rate limiters (`NewServer`): join `New(1, 5)`, login `New(0.5, 10)`, enroll `New(0.5, 10)`.

---

## FIXED

### Input validation

- [MEDIUM] **Malformed UUID in any path param or filter returned 500 instead of 400.** `internal/httpapi/handlers_sessions.go:61` (+ devices/sessions/audit handlers). Ids flowed unvalidated into `::uuid` casts, raising Postgres 22P02 → `writeServiceError` default 500. **Fix:** `parseUUIDParam` validates ids in handlers; non-UUID → 400.
- [MEDIUM] **Crafted audit cursor with a non-UUID id part returned 500.** `internal/httpapi/handlers_audit.go:91`. `decodeCursor` validated base64 + timestamp but not `parts[1]`. **Fix:** `decodeCursor` now `uuid.Parse`es the id part and returns the existing 400 "invalid cursor" path.

### Transaction safety

- [MEDIUM] **`CreateUnattended` was non-transactional + had a TOCTOU race.** `internal/service/session.go:72`. A failed `session.request` audit write orphaned a committed pending session that then blocked all future sessions for the device (409 forever); two concurrent requests could both pass `HasOpenSession`. **Fix:** session insert + audit wrapped in one pgx transaction; migration **`0002`** adds partial unique index `ux_sessions_open_device` on `sessions(device_id) WHERE status IN ('pending','active')`, mapping 23505 → `ErrConflict`.
- [MEDIUM] **Attended `Join` burned the one-time code before non-atomic writes.** `internal/service/attended.go:95`. GETDEL consumed the code, then `CreateDevice`/`BindSessionDevice`/audit ran separately; a partial failure left the user unable to retry with an orphan device row. Also `GetSession` returned `store.ErrNotFound` (a different sentinel than `service.ErrNotFound`), so a vanished session leaked a 500. **Fix:** post-redeem writes wrapped in a transaction; `store.ErrNotFound` → `service.ErrNotFound` (404).

### Authorization / attribution

- [MEDIUM] **Signaling WS authenticated the JWT but discarded operator identity.** `internal/httpapi/handlers_signal.go:24`. The socket bound by `session_id` only; any authenticated technician could attach to any session and all audit rows attributed to the session creator, not the acting operator. **Fix:** the WS now enforces `claims.Subject == sess.TechnicianID` (403 otherwise), closing the attribution gap. (Cross-referenced in `SECURITY_AUDIT.md`.)

### Correctness / error handling

- [LOW] **`EndSession` was not idempotent for the audit trail.** `internal/service/session.go:158`. Ending twice returned 200 both times and each wrote a fresh `session.end` event + re-notified peers; ending a pending session produced `session.end` with no `session.start`. **Fix:** short-circuits when already ended; `session.end` emitted only on a real transition.
- [LOW] **`VerifyDeviceToken` reported 401 for infra errors.** `internal/service/auth.go:98`. All store errors (including connection failures) collapsed to `ErrUnauthorized`, masking outages as auth failures during agent auth. **Fix:** only `store.ErrNotFound` maps to `ErrUnauthorized`; other errors surface as 500/503 so readiness/alerting reflect the real cause.
- [LOW] **`GetDevice` exposed attended ephemeral devices that `List` hides.** `internal/service/device.go:47`. `ListDevices` filters `mode='unattended'` but `Get` had no filter, so the two read paths disagreed. **Fix:** `Get` restricted to `mode='unattended'` (404 otherwise), matching `List`.
- [LOW] **Rate limiter did an O(n) map scan on every `Allow` at capacity.** `internal/ratelimit/ratelimit.go:53`. At 50k keys, every subsequent `Allow` iterated the whole map — a CPU-amplification vector under the brute-force flood it defends against. **Fix:** bounded per-call eviction → amortized O(1) with a true ceiling. (Also see `SECURITY_AUDIT.md` and `PERFORMANCE_REPORT.md`.)

### Test coverage

- [MEDIUM] **Service layer had zero unit tests.** `internal/service/session.go:118` (representative). Authorization-critical branches (`ActivateFromBanner` ownership, `ReportEvent` allowlist + `sanitizeEventMetadata`, `VerifyDeviceToken` failure paths) were covered only by infra-dependent integration tests. **Fix:** table-driven unit tests added for the pure/branchy service logic (plus `auth`/`ratelimit`), runnable in a plain `go test ./...`.

---

## DOCUMENTED

None among the 9 backend QA findings — all fixed. (Two backend-adjacent *security* items were documented by design; see `SECURITY_AUDIT.md`: org-wide audit readable by any technician (single-tenant), and the per-session cap on agent-reported events.)
