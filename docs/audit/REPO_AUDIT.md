# Repository Audit

Branch: `claude/remote-support-mvp-0chwrz`
Scope: whole-repo structure, dependency usage, dead code, TODO/FIXME classification, onboarding, hygiene.

**Verdict: unusually clean.** Every declared dependency is used, there is no dead or orphaned source, all TODO/FIXME markers are honest (documented Windows stubs or explicit UI "backend TODO" placeholders — no unmarked mocks or silent fakes), and the project is runnable from the README. The only defects were hygiene items, all fixed this pass.

---

## Structure

Three-stack monorepo, disjoint directories:

- `agent-rust/` — Windows-first endpoint agent (Rust). `src/` modules: `main` (service/portable/attended entry), `signal`, `webrtc`, `file`, `input`, `banner`, `heartbeat`, `enroll`, `audit_report`, `session`, `config`, `update`.
- `backend-go/` — Go API + WebSocket signaling. `internal/{httpapi,service,store,cache,audit,signal,auth,ratelimit,config}`, `cmd/server`, `migrations/`.
- `web-console/` — Next.js technician console. `app/` (11 routes), `lib/`, `components/`.
- `infra/` — `docker-compose.yml`, `coturn/`.
- `test/` — cross-stack runner (`run-all.sh`) + E2E drivers.
- `docs/` — architecture, API, security model, roadmap, test plan; `docs/audit/` (this set); `docs/history/` (archived point-in-time docs).

## Dependency usage

All declared dependencies across the three toolchains are used. No unused crates, Go modules, or npm packages were found feeding into shipped code paths. Two intentionally-unused-but-sanctioned items were confirmed and kept (both spec-mandated, documented in `docs/ARCHITECTURE.md` and `../../SECURITY_REVIEW.md` §1):

- `agent-rust/src/update.rs` — signed-update `UpdateChecker` trait + `unimplemented!()` stub; the spec's "architecture ready for signed updates."
- `agent-rust/src/webrtc.rs` `IceUrls` untagged enum — accepts string or array though the backend only emits strings; unit-tested defensive parsing.

## Dead / orphaned code

None in shipped source. The one hygiene defect was an unused UI export (see below).

## TODO/FIXME classification (47 markers)

Every marker was read and classified. **None is an unmarked mock or a hidden fake** — this was the load-bearing check for an audited remote-desktop product, and it holds.

- **Rust agent — documented Windows platform stubs (majority).** The OS-specific surfaces that cannot be implemented or exercised off Windows are stubbed behind a defined interface, and every stub announces itself:
  - `webrtc.rs` — screen media track (`attach_screen_track` logs `"is a TODO stub; no media track added (no fake frames)"` — importantly, it emits **no fake frames**).
  - `input.rs` — OS input injection (`#[cfg(windows)]` documents the injection path; non-Windows validates + audits but does not inject).
  - Native banner window, DPAPI token storage — stubbed with the interface defined.
- **Web console — honest UI placeholders.** Explicit "backend TODO"/"no endpoint yet" markers where a feature's backend does not exist:
  - `app/admin/technicians/page.tsx` — "management API (backend TODO). Only your own profile is shown today."
  - `components/shell/RelayHealth.tsx` — "no relay-metrics endpoint yet."
  - `components/session/SessionRightPanel.tsx` — Resolution/FPS placeholders and outbound-file-transfer ("protocol defined; agent side is a TODO"), all tied to the Windows agent capture stub.
- **Go backend — zero TODO/FIXME.**

No marker hides an untested branch presented as working. The stubs fail visibly (log/placeholder), never silently.

## Onboarding assessment

Runnable from the README: `cp .env.example .env` → `docker compose up --build` (migrations auto-run on boot). The DevOps pass closed the two documented-flow breakers that previously blocked a from-scratch local run (missing `APP_ENV`, ICE_SERVERS mangling in the env-export recipe — see `DEVOPS_REPORT.md`). A root `Makefile` now gives one entry point per task across all three toolchains, so a contributor no longer needs to know cargo/go/npm invocations individually.

## Hygiene fixes (FIXED this pass)

- [LOW] **Unused `Kbd` export removed** — dead UI export in the web console, deleted.
- [LOW] **Orphaned UX docs archived** — point-in-time UX planning/review docs that were sitting in the web-console root moved to `docs/history/` (`UX_AUDIT.md`, `PRODUCT_UX_PLAN.md`, `FINAL_UI_REVIEW.md`) so they are retained but out of the active source tree.
- [INFO] **`.gitignore`** now ignores `*.tsbuildinfo`.

## Documented (no code change needed)

- The two sanctioned unused stubs above (`update.rs`, `IceUrls`) — kept intentionally per spec; recorded here so future readers do not mistake them for dead code.
