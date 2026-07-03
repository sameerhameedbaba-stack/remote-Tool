# Security Audit

Remote-desktop-specific security review from this audit pass. 9 findings, ranked by severity. Cross-references the prior [`../../SECURITY_REVIEW.md`](../../SECURITY_REVIEW.md) (13 raised → 9 confirmed → 8 fixed + 1 deferred), whose fixes were re-confirmed to still hold.

## Remote-desktop safety checks (all hold)

This is a consented, audited, banner-enforced remote-support product. The load-bearing guarantees were re-verified this pass:

- **Auditable.** All three data-channel events (`file.transfer`, `clipboard.sync`, `input.command_attempt`) persist to the append-only audit store via device-authenticated `POST /agent/events`, with server-side metadata whitelisting (content dropped). E2E asserts all six audit event types.
- **Banner mandatory, no silent mode.** The agent state machine makes `Active` reachable only via `BannerShown`; `banner.rs` has no suppress flag; the backend independently gates activation on the agent's `banner:{visible:true}` ack. Confirmed unchanged.
- **Technician identity now on the banner.** Previously hardcoded `"Technician"`; the `session-control:start` payload now carries `technician_name` and the agent renders the real operator (fail-closed to `"Unknown technician"`). The controlled user can see WHO is connecting.
- **Device identity.** Every agent call is device-token authenticated; `VerifyDeviceToken` now distinguishes not-found (401) from infra errors (500/503).
- **No RCE / no hidden session.** Re-confirmed from `../../SECURITY_REVIEW.md` §1 — zero process-spawn hits on any request/data-channel path; input channel is allowlisted OS key/mouse events only.
- **Enroll no longer open to unlimited brute-force.** `/agent/enroll` now rate-limits failed (bad-token) attempts per source IP and audits `device.register_failed`.

## Prior SECURITY_REVIEW.md fixes — still hold

The 8 fixed findings from the prior review were spot-checked and remain in force: socket-peer-IP rate-limiter keying (no XFF trust), no keystroke-content capture in `input.command_attempt`, persisted+whitelisted data-channel events, bounded rate-limiter map, audit-before-activate ordering, login timing-oracle dummy-verify + rate limit, HMAC-SHA256 session codes, Windows reserved-DOS-name rejection. The 1 deferred item (WS token in URL query) remains documented/deferred with the same mitigations.

---

## Findings (this pass)

### Medium

- [MEDIUM] **Consent banner never showed the real technician identity.** `agent-rust/src/main.rs:147`/`:212` + backend `session-control:start`. Banner always read "Technician: Technician"; the end user could not learn who was viewing their machine, undermining informed consent. **Status: FIXED (cross-stack B+A).** Backend emits `technician_name`; agent parses it and renders it, failing closed to "Unknown technician."
- [MEDIUM] **Signaling WS authenticated the JWT but discarded operator identity.** `backend-go/internal/httpapi/handlers_signal.go:24`. Socket bound by `session_id` only; any authenticated technician could attach to any active session and drive input, and all audit rows were attributed to the session creator rather than the acting operator. **Status: FIXED.** WS now enforces `claims.Subject == sess.TechnicianID` (403 otherwise); attribution reflects the real operator.
- [MEDIUM] **`/agent/enroll` had no rate limit and failed attempts were not audited.** `backend-go/internal/httpapi/server.go:75`. The public route was guarded only by a constant-time shared-token compare; a bad token returned 401 with no audit trail, enabling unlimited online brute-force of the shared enrollment token. **Status: FIXED.** Per-source-IP `enrollLimiter` on failed attempts + `device.register_failed` audit. (Refined to limit only *failed* attempts — see the enroll-limiter story in `INTEGRATION_TEST_REPORT.md`.)

### Low

- [LOW] **Rate limiter O(n) full-map scan under the global mutex; can grow past cap under hot high-cardinality load.** `backend-go/internal/ratelimit/ratelimit.go:63`. At/over 50k keys, every `Allow` paid an O(n) scan holding a process-wide lock — self-inflicted contention under exactly the flood it defends against. **Status: FIXED.** Amortized/bounded eviction with a true ceiling. (Also in `BACKEND_QA_REPORT.md` / `PERFORMANCE_REPORT.md`.)
- [LOW] **Audit filter UUID params caused 500 instead of 400 on malformed input.** `backend-go/internal/store/audit.go:52`. Not injection (fully parameterized) but poor validation that misreported client errors and logged noise. **Status: FIXED.** UUID validation in the handler (and cursor) → 400. (Same fix family as the input-validation findings in `BACKEND_QA_REPORT.md`.)
- [LOW] **Web console served no security headers.** `web-console/next.config.mjs:1`. No CSP / X-Frame-Options / X-Content-Type-Options; because the technician JWT is deliberately in a JS-readable cookie, any XSS yields token theft and the console is clickjackable. **Status: FIXED.** `headers()` block adds a restrictive Content-Security-Policy, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy` for all routes.
- [LOW] **ESLint not CI-enforceable for the web console.** `web-console/package.json:1`. The one TS/React codebase handling auth tokens + untrusted signaling data had no lint gate. **Status: FIXED.** ESLint flat config + `--max-warnings=0` script + CI step. (Cross-referenced in `DEVOPS_REPORT.md`.)
- [LOW] **File-chunk memory-amplification + duplicate-offer overwrite (agent).** `agent-rust/src/file.rs:208`. Peer-supplied base64 fully decoded before the 4 MiB cap; a duplicate active offer id replaced an in-flight transfer. **Status: FIXED.** Reject on encoded length pre-decode; reject an already-active offer id. (Also in `AGENT_QA_REPORT.md`.)

---

## Documented / accepted (by design for the MVP)

- [LOW] **Org-wide audit log readable by any technician role (no admin gate).** `backend-go/internal/httpapi/server.go:83`. `/audit` is under `requireTech`; any technician can read the cross-session log (other techs' emails/login IPs). **Status: DOCUMENTED — single-tenant by design** (consistent with `../../SECURITY_REVIEW.md` §3). **Remediation when RBAC lands:** gate `/audit` behind a `role==admin` middleware reading `techFrom(ctx).Role` (the claim already exists).
- [LOW] **No per-session cap on device-reported audit events.** `backend-go/internal/service/agent.go:118`. A compromised agent holding a valid ephemeral device token for its own live session could POST `/agent/events` in a loop to flood the audit table. **Status: DOCUMENTED.** Blast radius is bounded by the new async best-effort worker (`PERFORMANCE_REPORT.md`). **Remediation:** a per-device/per-session token bucket on `/agent/events` and/or server-side coalescing of identical event types.

---

## Verdict

Core security model sound and enforced in code: consent + mandatory banner (now with real technician identity), device-identity auth, keyed-hashed single-use session codes, complete content-free audit trail with correct operator attribution, auth on every non-public endpoint, enroll no longer brute-forceable without a trail, and no RCE / hidden-session path. All Medium findings fixed; the two remaining items are Low and documented as single-tenant-MVP tradeoffs. Re-run this review before any release.
