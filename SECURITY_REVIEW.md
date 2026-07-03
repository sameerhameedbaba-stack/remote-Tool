# Security Review — Remote Support MVP

This is the fresh-context security + scope review required by the build spec. It
was produced by independent reviewer agents that had not written the code, using
an adversarial workflow: for each dimension, one agent found issues and separate
agents re-read the actual code to **confirm or refute** each finding before it
counted. A parallel scope/architecture reviewer checked for out-of-scope
features and overengineering.

- Reviewers: 1 scope reviewer + 6 security dimensions (secrets, auth, session
  codes, audit coverage, untrusted peer data, transport/CORS/web/injection),
  each finding independently verified. 20 agents total.
- Result: **13 findings raised → 9 confirmed, 4 refuted.** Scope verdict:
  **no out-of-scope features; both safety boundaries hold.**
- Disposition: **8 of 9 confirmed findings fixed in code; 1 documented and
  deferred.** All fixes were re-verified (builds + a live backend run).

The review is checked against the guarantees in
[`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md).

---

## 1. Scope & safety-boundary check

**No forbidden/out-of-scope feature is implemented.** The two hard safety
boundaries were verified to hold:

- **No remote code execution.** A grep across the agent and backend for process
  spawning (`std::process`, `Command`, `os/exec`, `powershell`, `cmd.exe`,
  `sh -c`) found **zero** hits on any request or data-channel path. The `input`
  data channel is strictly allowlisted to OS key/mouse events with no branch to
  process execution.
- **No hidden/silent session.** The agent state machine makes `Active`
  unreachable except via `BannerShown` (a direct `Pending → Active` is rejected
  and unit-tested); the banner module has no suppress flag and always emits a
  visible banner on every platform; and the backend independently gates
  activation on the agent's `banner:{visible:true}` ack.

Two **overengineering** items were noted, both sanctioned by the spec and kept:

1. `agent-rust/src/update.rs` — the signed-update `UpdateChecker` trait + impl
   are unused `unimplemented!()` stubs. This is the spec's required "architecture
   ready for signed updates," so it is kept intentionally (documented in
   `docs/ARCHITECTURE.md` §6).
2. `agent-rust/src/webrtc.rs` — the `IceUrls` untagged enum accepts a string or
   array though the backend only emits strings. Harmless, unit-tested defensive
   parsing; kept.

---

## 2. Confirmed findings and dispositions

| # | Sev | Area | Finding | Disposition |
|---|-----|------|---------|-------------|
| 1 | HIGH | session codes | `/attended/join` rate limiter keyed on client-controlled `X-Forwarded-For`, so an attacker could rotate the key and brute-force codes | **Fixed** — limiter now keys on the real socket peer IP; XFF is never trusted (`httpapi/context.go`) |
| 2 | HIGH | audit | `input.command_attempt` log captured keystroke content (key `code` + modifiers), violating the "no keystroke contents" guarantee | **Fixed** — logs only a discriminant (`kind` + `action`); never the code/coords/modifiers (`agent-rust/src/input.rs`) |
| 3 | MED | audit | The three data-channel events (`file.transfer`, `clipboard.sync`, `input.command_attempt`) were only local agent logs, never persisted to the audit store | **Fixed** — added device-authenticated `POST /agent/events`; the agent now reports them (input aggregated to a count); backend whitelists metadata (`service/agent.go`, `agent-rust/src/audit_report.rs`) |
| 4 | MED | session codes | Rate-limiter map grew unbounded (never pruned) and was fed attacker-controlled keys → memory-exhaustion vector | **Fixed** — bucket map is size-bounded with idle-bucket eviction (`ratelimit/ratelimit.go`); the XFF fix (#1) also removes the unbounded-cardinality source |
| 5 | MED | audit | `session.start` audit failure did not fail the action; a session could be left active with no start record | **Fixed** — audit is written before the session is marked active, and the WS handler treats activation failure as fatal (ends the session) (`service/session.go`, `httpapi/handlers_signal.go`) |
| 6 | LOW | auth | Login timing oracle: argon2 ran only for known emails → user (email) enumeration; login was not rate-limited | **Fixed** — unknown-email branch runs an equivalent dummy argon2 verify; `/auth/login` is now rate-limited per IP (`auth/password.go`, `service/auth.go`, `httpapi/server.go`) |
| 7 | LOW | session codes | Session code stored as unsalted SHA-256 over a low-entropy numeric value → offline-reversible if Redis leaked | **Fixed** — codes are now stored as a **keyed HMAC-SHA256** (server secret), so a Redis leak alone cannot reverse them (`auth/sessioncode.go`) |
| 8 | LOW | untrusted data | Windows reserved DOS device names (`CON`, `NUL`, `COM1`…) passed filename sanitization and could escape the downloads dir on Windows | **Fixed** — reserved names are rejected on all platforms (`agent-rust/src/file.rs`) |
| 9 | LOW | transport | Technician JWT / device token passed as a WebSocket URL query parameter (`?token=`), more log-exposed than a header | **Documented + deferred** — browsers cannot set `Authorization` on a WS handshake; mitigated by short JWT TTL + origin checks. Planned fix: a single-use short-TTL WS ticket (`docs/SECURITY_MODEL.md` §8.9, `docs/ROADMAP.md`) |

### Fix verification

After applying the fixes, all build gates were re-run green (`go build`/`vet`/
`test`, `cargo check`/`test` — now 33 agent tests, `npm run build`), and a live
backend run confirmed the security-relevant behavior:

- `/agent/events`: `202` for a device that owns the session, `403` for a device
  that does not, `400` for a non-whitelisted `event_type`, `401` without a
  device token. Injected `secret_field`/clipboard `text` were **dropped** — the
  stored `file.transfer` metadata was exactly `{name, size, direction}`.
- `/auth/login`: a burst of wrong logins returned `401` up to the burst
  capacity, then `429` — rate limiting is active.

---

## 3. Refuted findings (raised but not real defects)

Recorded for transparency; each was re-read and dismissed:

- **Placeholder-JWT boot guard "disabled" in dev** (claimed medium) — Working as
  documented. `SECURITY_MODEL.md` states placeholder rejection is enforced
  outside `APP_ENV=dev`; the `>=32`-byte length check is always on. Dev
  deployments are explicitly localhost-only.
- **Any technician can attach to any session** (claimed info) — Accurate but this
  is the **documented single-tenant authz** model for the MVP (see
  `SECURITY_MODEL.md` §2 and the multi-tenant ROADMAP item), not a defect.
- **Auth cookie set without `Secure`** (claimed low) — The same JWT already
  travels in the `Authorization` header, and production requires TLS termination
  (ROADMAP); not a meaningful additional exposure for the MVP.
- **List-sessions `limit` unvalidated** (claimed low) — Refuted: the service
  layer clamps `limit` to `[1,100]` (default 50) before the parameterized query
  runs; queries are parameterized, so no injection or unbounded scan.

---

## 4. Residual accepted risks (MVP)

These remain by design and are documented in `docs/SECURITY_MODEL.md` §8 /
`docs/ROADMAP.md`; none weakens the core guarantees (consent, banner, audit,
no-RCE):

- No TLS in the box (operator terminates TLS; dev is localhost plaintext).
- Single shared enrollment token; JWTs not revocable mid-TTL.
- Single-instance signaling hub; in-process (not shared) rate limiter.
- Static TURN credentials; coarse single-tenant authorization.
- Insecure dev-only device-token file fallback off Windows (never ship).
- WS auth token in the URL query (finding #9) pending the WS-ticket fix.

## 5. Conclusion

The MVP's core security model is sound and enforced in code: consent + mandatory
banner, device-identity auth, short-lived single-use (now keyed-hashed) session
codes, a complete audit trail (now including the data-channel events, with no
content capture), auth on every non-public endpoint, and no remote-code-execution
or hidden-session path. All high- and medium-severity findings from this review
were fixed and re-verified; the remaining items are low-severity and documented.
This review should be re-run before any release.
