# Code Quality Report

Web console (`web-console/`). 7 findings, all behavior-preserving refactors. All fixed this pass.

These were quality-only (duplication, magic constants, weak typing, mixed responsibilities) — no correctness bugs. The correctness/security frontend findings are in `FRONTEND_QA_REPORT.md`. All refactors preserved E2E anchors and pass `tsc` + ESLint (0 warnings) + 48 vitest tests.

---

## FIXED

- [MEDIUM] **Session-connect + ICE-stash flow duplicated across three files.** `app/dashboard/page.tsx:187`, `app/devices/page.tsx:125`, `components/shell/CommandPalette.tsx:97`. The `createSession → sessionStorage.setItem('rs_ice:'+id, ...) → router.push('/sessions/'+id)` sequence was hand-copied and had already drifted (dashboard/devices set an error state; CommandPalette silently routed to /devices). **Fix:** extracted `lib/session-connect.ts` (`stashIceServers(sessionId, servers)`, `startDeviceSession(token, deviceId)`, `iceStashKey(sessionId)`); all three call sites use it while keeping their own error/navigation handling.
- [LOW] **`ApiError` message-extraction idiom repeated at 8 call sites.** `app/dashboard/page.tsx:146` (+ devices, sessions/[id], audit). The `err instanceof ApiError ? err.message : "<fallback>"` ternary and the `err.code === "network_error"` swallow-guard were reimplemented inline everywhere. **Fix:** two helpers next to `ApiError` in `lib/api.ts` — `errorMessage(err, fallback)` and `isNetworkError(err)`; inline idioms replaced.
- [LOW] **`"rs_ice:"` key prefix and 10s poll interval were scattered magic constants.** `app/sessions/[id]/page.tsx:60` (read) + three write sites; `10_000` duplicated in dashboard/devices. A rename on one side silently broke the ICE hand-off. **Fix:** key centralized via `iceStashKey()` in the shared module (read + write can't diverge); poll interval hoisted to a named `PRESENCE_POLL_MS` constant.
- [LOW] **`loadStashedIceServers` had a read helper but no matching write helper.** `app/sessions/[id]/page.tsx:58`. Read half had proper try/catch + shape validation; the three write sites inlined `setItem(JSON.stringify(...))` with an empty catch — asymmetric halves of one protocol in different files. **Fix:** read + write helpers colocated in the shared `session-connect` module.
- [LOW] **Audit timeline dot re-implemented the `kind→color` mapping `StatusBadge` already owns.** `app/audit/page.tsx:249`. A nested ternary mapped `meta.kind` to a background color two lines above the `StatusBadge` that owns the same vocabulary — two definitions that can drift. **Fix:** extracted `kindDotClass(kind)` colocated with the audit-meta/kind definitions; the dot uses it.
- [INFO] **`openPanel` widened `PanelTab` to `string` then cast back.** `app/sessions/[id]/page.tsx:288`. Typed `(tab: string) => setPanelTab(tab as PanelTab)`, defeating the union — the toolbar could pass an invalid tab id and compile. **Fix:** parameter typed as `PanelTab` and `SessionToolbar.onOpenPanel` typed `(tab: PanelTab) => void`; cast dropped.
- [INFO] **`sessions/[id]/page.tsx` mixed input-mapping utilities with the page component.** `app/sessions/[id]/page.tsx:43`. Pure DOM-event→InputMessage translators (`mouseButtonName`, `modifiersFrom`, `normalizedCoords`) lived inline in the 476-line component. **Fix:** moved to `lib/input-mapping.ts` — smaller component, now unit-testable (covered by the new vitest suite). No broader rewrite of the component was attempted (the rest of its size is legitimately distinct concerns).

## Related extraction

Beyond the seven findings, executable-file detection was extracted to `lib/file-safety.ts` (was inline `isDangerous()` in `SessionRightPanel.tsx`), making the security-relevant `.exe/.ps1` gate unit-testable — covered in `FRONTEND_QA_REPORT.md` (the test-coverage finding).

## DOCUMENTED

None — all seven fixed.
