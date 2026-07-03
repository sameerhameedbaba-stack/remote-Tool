# Performance Report

6 findings. All fixed this pass.

## What was already good

- **Keyset audit pagination.** `ListAuditEvents` already used a keyset cursor (`created_at DESC, id DESC`) rather than OFFSET — the ordering/cursor design was correct and was kept unchanged; only the filter predicates were rebuilt (finding below).
- **Indexed hot lookups.** Presence/status is derived from Redis (O(1) TTL key), and the primary-key/id lookups on the hot paths were already index-served. The device-list scan and the audit *filter* were the two query-shape defects.

---

## FIXED

- [HIGH] **Unattended agent had no signaling reconnect/backoff — one WS drop silently disabled the device.** `agent-rust/src/main.rs:140`. `run_unattended()` connected once; when the read pump ended (backend restart, LB idle timeout, network blip) the loop returned and the process stopped serving sessions, while the heartbeat task kept refreshing the Redis presence key — so the backend/console showed the device ONLINE. A technician's `CreateUnattended` then passed the online check, created the session, `SendToAgent()` returned false (only an Info log), and the session hung pending with no banner. **Fix:** outer reconnect loop with capped exponential backoff + jitter (reset on a successful long-lived connection); heartbeat unchanged. (See `AGENT_QA_REPORT.md` reliability rewrite.)
- [MEDIUM] **Audit filter couldn't use its indexes (OR-with-empty-param) and scanned an unbounded table.** `backend-go/internal/store/audit.go:48`. The `($1 = '' OR session_id = $1::uuid) AND ...` shape prevented the planner from using `idx_audit_session_id`/`device_id`/`technician_id`; filtering for one older session forced a backward scan of every newer event — O(table size) for a rare event, exactly the console's per-session view. **Fix:** the WHERE clause is built dynamically, appending only the predicates actually set, so a `session_id` filter emits `session_id = $n` and the index is used. Keyset cursor + ORDER BY unchanged.
- [MEDIUM] **Heartbeat wrote `last_seen_at` to Postgres on every beat.** `backend-go/internal/service/agent.go:74`. Every 15s tick did BOTH `SetPresence` (Redis) and `UpdateLastSeen` (an UPDATE on `devices`), though online/offline status derives entirely from Redis — the DB write existed only for a "last seen X ago" display. At fleet scale that is continuous WAL/row-version churn/autovacuum pressure scaling linearly with N (~133 UPDATE/s at 2,000 devices). **Fix:** the DB write is throttled — only when `last_seen_at` is stale by > ~2 min or `app_version` changes; `SetPresence` still runs every beat so real-time status stays exact.
- [MEDIUM] **Device list endpoint was unbounded and used a leading-wildcard ILIKE, polled every 10s.** `backend-go/internal/store/devices.go:35`. No LIMIT; `name ILIKE '%'||$1||'%'` is non-sargable; no index for `mode='unattended'` or the `ORDER BY created_at DESC`; every call was a full scan+sort returning every device (including `device_secret_hash`) to the client on a 10s cadence per open tab. **Fix:** pagination (LIMIT, default 100 / max 200) + index `idx_devices_mode_created_at` (migration `0002`); the list DTO no longer selects `device_secret_hash`.
- [LOW] **pgx connection pool left at defaults.** `backend-go/internal/store/store.go:26`. `pgxpool.New` with no tuning → `MaxConns = max(4, numCPU)`, no `MaxConnLifetime`/`HealthCheckPeriod`; under concurrent heartbeat UPDATEs + a CPU-heavy argon2id login + dashboard polling, a 4-conn pool serializes DB access, and long-lived conns aren't recycled behind a terminating proxy. **Fix:** tuned via `ParseConfig` — MaxConns 15, a small MinConns, MaxConnLifetime, MaxConnIdleTime, HealthCheckPeriod.
- [LOW] **Best-effort audit write slept synchronously inside the `/agent/events` request goroutine.** `backend-go/internal/audit/audit.go:80`. `RecordBestEffort` retried up to 3× with `time.Sleep(10ms,20ms)` inline; during a DB hiccup every data-channel event blocked its HTTP goroutine ~30ms before returning 202 — turning a transient DB slowdown into request-goroutine pileup on the highest-volume endpoint. **Fix:** best-effort writes handed to a bounded background worker (detached ctx, drop-and-log on overflow, drained on shutdown); the request returns 202 immediately. Synchronous `Record()` for lifecycle events unchanged.

Also relevant: the **rate limiter O(n)-scan-at-cap** fix (`ratelimit.go`) is a CPU/lock-contention improvement covered in `BACKEND_QA_REPORT.md` and `SECURITY_AUDIT.md`.

## Related indexes (migration `0002`)

`0002_session_and_device_indexes` adds `idx_devices_mode_created_at` (default ordered device scan) and the partial unique index `ux_sessions_open_device` (correctness/TOCTOU, `BACKEND_QA_REPORT.md`).

## DOCUMENTED

None among the six perf findings — all fixed.
