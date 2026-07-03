# UX Audit — Remote Support Console

**Auditor:** Head of Product Design
**Date:** 2026-07-03
**Scope:** The entire web console shipped today (login, dashboard, devices, live session, audit, shared chrome, design foundation).
**Benchmark:** Cleaner than AnyDesk, as restrained as Apple.com, as color-disciplined as Google, as sharp as Linear, as polished as Stripe.
**Verdict up front:** This is a competent, type-safe, accessible-ish *scaffold*. It is not a product. Today it reads as a well-behaved generic dark admin template — the kind a code generator produces when told "make an MSP dashboard." For a remote-control product where trust, speed, and situational awareness are the entire value proposition, the current UI communicates almost none of it. Nothing here is broken; almost nothing here is *designed*.

---

## Scoreboard

| Screen / Area | Current | Target | Gap |
|---|---:|---:|---:|
| Design foundation (color / type / spacing / components) | 3.5 | 9 | 5.5 |
| Shared chrome (nav / layout) | 4 | 9 | 5 |
| Login | 4 | 9 | 5 |
| Dashboard | 3 | 9 | 6 |
| Devices (address book) | 4 | 9.5 | 5.5 |
| Live session | 3.5 | 9.5 | 6 |
| Audit log | 4.5 | 9 | 4.5 |
| **Overall** | **3.8** | **9.2** | **5.4** |

---

## 1. Design Foundation — 3.5 / 10

Files: `tailwind.config.ts`, `app/globals.css`, `components/ui.tsx`

### What's there
A single dark surface ramp (`surface.950 → 600`), one blue accent ramp (`accent.400/500/600`), and Tailwind's stock `slate`, `emerald`, `amber`, `red`, `blue`, `violet` used ad hoc. Components are five `@layer` classes: `.btn*`, `.card`, `.input`, `.label`, `.badge`. Type is 100% default system/Tailwind sans at default weights; there is no font declaration anywhere.

### Weaknesses
- **No typographic system.** There is no custom font, no type scale, no `font-feature-settings`, no tracking discipline. Every heading is `text-2xl font-semibold text-white` and every body is `text-sm text-slate-400`. Apple/Stripe/Linear polish is *primarily* typography — a real display face (or a well-tuned Inter/Geist with tabular numerals and tightened tracking on headings). Its absence is the single biggest reason this reads "AI-generated." Numerics that matter (session timers, device counts, the attended code) should be `tabular-nums` everywhere; only the countdown bothers.
- **Color is undisciplined and un-tokenized.** The palette is hard-coded hex in `tailwind.config.ts` with the honest comment "Kept as CSS-var-free tokens for simplicity." That means: no light mode is even possible, no theming, no semantic layer. Colors are applied literally (`bg-emerald-500/15`, `text-blue-300`, `bg-violet-500/15`) rather than through intent tokens (`--color-success`, `--color-danger`, `--color-info`). Google's discipline is *semantic* color: one functional meaning per hue, used sparingly. Here `blue` means "auth event," `accent` (also blue) means "primary action," and `accent` again means "live session timer" — three unrelated meanings, two nearly identical blues. The violet for `device.register` is decorative noise.
- **The accent blue is generic.** `#2b8bff` is the default "SaaS blue." It carries no brand. Every competitor screenshot uses this exact blue. A premium product picks a signature and commits.
- **Flat, single-elevation surface model.** `.card` is `border + bg-surface-900 + shadow-sm`. Every container in the app is that one card. There is no elevation hierarchy (resting / raised / overlay), no layering language, no depth for modals/popovers/toasts because none exist. The whole app is one plane.
- **Spacing is coarse and repetitive.** Everything is `px-4 py-8`, `gap-4`, `gap-6`, `mb-6`, `mt-8`. No 4px-based rhythm decisions, no optical alignment, no density modes. Tables use `px-4 py-3` uniformly regardless of column content. A technician tool needs a *dense* mode; this is all one comfortable-but-generic density.
- **Border-driven separation everywhere.** Nearly every boundary is a 1px `border-surface-700`. Linear/Stripe lean on subtle background steps, hairlines, and shadow — not boxes-inside-boxes. The result here is a "panels of panels" look.
- **Component library is threadbare.** Five primitives. No: secondary/tertiary/ghost button sizing scale, icon buttons, `Tooltip`, `Modal`/`Dialog`, `Toast`/notification, `Menu`/dropdown, `Tabs`, `Skeleton`, `Spinner`, `EmptyState`, `Avatar`, `Kbd`, `Tag/Chip` with remove, `Table` component (tables are hand-rolled per page). Errors are a copy-pasted red `div` on four screens. This guarantees inconsistency as the app grows.
- **No motion system.** Only `transition-colors` on hover and one `animate-pulse` dot. No enter/exit transitions, no optimistic feedback, no skeleton shimmer. Polished products feel alive; this is static.
- **No iconography.** The entire app has zero icons except a literal letter "R" in a blue square as the logo. Devices have no OS glyphs, nav has no icons, actions have no affordant symbols. This alone makes it look unfinished next to AnyDesk/ScreenConnect.
- **Focus ring uses `ring-offset-2` against `surface-950` globally** — fine for accessibility, but applied identically to buttons on colored backgrounds it will look detached. No focus *style* differentiation.

### World-class version
A real design-token layer (CSS variables) with semantic intents (`bg/surface/raised/overlay`, `text/primary/secondary/muted`, `border/subtle/strong`, `accent`, `success/warning/danger/info`) that supports **light and dark**. A signature accent that is not stock blue. A tuned type scale (e.g. Inter/Geist Display for headings with negative tracking, tabular numerals globally for metrics). A three-level elevation model. A proper primitive library (Button with variants/sizes, IconButton, Tooltip, Dialog, Toast, Menu, Tabs, Skeleton, EmptyState, StatusDot, Kbd, Avatar) built once and reused. A crisp icon set (Lucide/Phosphor) with OS logos for devices. A quiet motion system (120–200ms ease, skeletons, toast slide-ins).

---

## 2. Shared Chrome — Nav & Layout — 4 / 10

Files: `app/layout.tsx`, `components/NavBar.tsx`

### Weaknesses
- **A top nav is the wrong chrome for this product.** Technician consoles are dense, multi-context tools (address book + live session + audit) — they want a persistent **left rail** with room for teams/groups, saved filters, org switching, and a global command bar. A 56px top bar with three text links (`Dashboard / Devices / Audit`) is the shape of a marketing site, and it caps the app's growth.
- **No global search / command palette.** For a "technician-first, speed" product, the absence of a `⌘K` quick-connect / device jump is the biggest speed failure in the whole app. AnyDesk's core interaction is "type an address, connect." Here you must navigate to Devices and scan a table.
- **No presence or "active session" awareness in the chrome.** If a technician is in a live session and navigates away, nothing in the nav shows a session is running. There is no persistent "1 active session" pill, no way to jump back, no global live-session indicator. For a remote-control tool this is a trust and safety gap, not just UX.
- **Logout is the only account affordance.** No user menu, no settings, no role display, no org/tenant switcher, no theme toggle, no help. The technician's name/email is dead text, not a menu.
- **Branding is a letter in a box.** `R` in a blue square. No logo, no product name treatment. Reads as placeholder.
- **Active-state styling is weak.** Active link = `bg-surface-700`; inactive = `text-slate-400`. Low contrast, no accent, no underline/indicator bar. Hard to scan which section you're in.
- **No breadcrumbs or page-level context.** Deep pages (`/sessions/[id]`) have no path back except an inline "← Back to devices" text link at the very bottom.
- **Layout is just `max-w-7xl` centered.** Fine, but it means the live-session screen — which should be immersive and near-full-bleed — is boxed into the same 80rem column as a settings form.
- **No responsive story for the table pages.** Below `sm`, the device/audit tables just horizontal-scroll. No card fallback, no priority columns.

### World-class version
A slim, collapsible **left rail** with iconned sections (Dashboard, Devices/Address book, Sessions, Audit), org/tenant switcher at top, technician avatar + menu (profile, role, theme, sign out) at the bottom. A persistent **global command bar (`⌘K`)** for quick-connect by device name/ID/attended code. A **persistent active-session indicator** in the chrome ("1 live • 04:12 • Jane's Laptop") that's always one click from re-entry. Breadcrumbs on detail pages. The live-session route escapes the max-width and goes near-full-bleed.

---

## 3. Login — 4 / 10

File: `app/login/page.tsx`

### Weaknesses
- **Generic centered card.** Logo-in-box, H1, subtitle, two fields, full-width blue button. This is the literal default auth screen; it could belong to any product. Nothing signals "secure remote-support platform for enterprises."
- **No trust framing.** A tool that grants strangers control of machines should *radiate* security at the front door: SSO/SAML entry point, MFA affordance, "your session is audited" reassurance, org/tenant identification, environment/region indicator. None present. There's just email + password.
- **No SSO / enterprise auth.** Enterprise buyers expect "Sign in with SSO." Password-only is a deal-breaker signal.
- **Missing states.** No "forgot password," no rate-limit / lockout messaging, no caps-lock hint, no show/hide password toggle, no "remember this device." The error is the same generic red box used app-wide.
- **No brand or product personality.** No split-panel with product imagery/marketing, no version/build, no legal footer, no support link.
- **`min-h-screen` centering with a `max-w-sm` card** is textbook template composition.

### World-class version
A confident split or centered composition with real brand identity; primary **SSO** button with email/password as secondary; MFA step; show/hide password; forgot-password; org/tenant + region context; a quiet trust line ("All sessions are consented, banner-enforced, and audited"); careful error states (invalid creds vs locked out vs network). Restrained, Apple-like — lots of negative space, one confident type moment.

---

## 4. Dashboard — 3 / 10

File: `app/dashboard/page.tsx`

This is the weakest screen because it best exemplifies "AI-generated dashboard."

### Weaknesses
- **Four stat cards in a row — the definition of template.** "Devices online / Active sessions / Recent sessions / Offline devices." `Recent sessions = 5` is a meaningless metric (it's literally the `limit`, capped at 5). These KPIs are vanity; none is actionable, none links anywhere, none trends over time.
- **Loading state is the character `…` inside each stat.** No skeletons. Values pop in. Feels unfinished.
- **The most valuable technician actions are buried.** "Start attended session" (generate code) is a half-width card competing with a "Recent sessions" list. There is no quick-connect, no "jump to a device," no "resume active session." The dashboard doesn't accelerate the core job.
- **The attended-code panel is the one genuinely good idea, under-designed.** It shows the code big with a live countdown (nice), but: no **copy button**, no **QR code**, no explicit "share to end user" flow, no list of *outstanding* codes (create one, it replaces state; there's no history), and the panel is dismiss-only. For attended support this should be a first-class, prominent flow.
- **"Recent sessions" list is thin.** Each row is an 8-char id, `type · time`, and a status badge. No device name, no technician, no duration, no way to act (rejoin/end/view). You cannot tell *what machine* a session touched — the single most important fact.
- **No fleet situational awareness.** No online/offline breakdown visual, no OS distribution, no "devices that went offline recently," no alerting, no unattended-vs-attended split, no active-sessions live panel showing *who is controlling what right now* — which is exactly what an MSP lead opens this page to see.
- **No empty/first-run state.** A brand-new org sees `0 / 0 / 0 / 0` and an empty list with "No sessions yet." No onboarding, no "register your first device," no guidance.
- **No time context / refresh control / last-updated.** Data loads once; nothing tells you how fresh it is (the devices page polls, but the dashboard doesn't).

### World-class version
Lead with **action + live state**, not vanity KPIs: a prominent **Quick Connect** (device search / attended code / enter address) as the hero; a **live "Active sessions now"** panel showing device, technician, duration, consent/recording state, with one-click rejoin/end; an **attended-code studio** with copy + QR + outstanding-codes list; a compact, *meaningful* fleet-health strip (online/offline/attention-needed) with trend, each drilling into a filtered device list. Real skeletons. A thoughtful first-run/empty state.

---

## 5. Devices (Address Book) — 4 / 10

File: `app/devices/page.tsx`

This is the technician's home base and the product's core. It's a plain HTML table.

### Weaknesses
- **It's a spreadsheet, not an address book.** Columns: Name, Hostname, OS, Mode, Status, Last seen, Action. No grouping (by customer/site/team), no favorites/pinning, no tags, no saved views, no sort, no column of *who's connected now*, no device avatar/OS glyph, no notes. AnyDesk/ScreenConnect address books are organized, searchable trees; this is a flat list.
- **Search is name/hostname substring only, client-side.** The API exposes `q` and `status` filters (`ListDevicesParams`) and they're unused — the page fetches all devices and filters in the browser. Won't scale past a page of devices, and there's no filter-by-status/OS/mode UI at all.
- **Connect is one narrow gated button.** `canConnect = online && unattended`. Attended and offline devices get a disabled button with a `title` tooltip as the *only* explanation — no visible reason, no alternate action (e.g. "wake," "request attended," "view details"). A disabled primary button with no path forward is a dead end.
- **No device detail view.** `getDevice` exists in the API and is never used. Clicking a device does nothing; there's no drawer/page with history, past sessions, hardware, notes, or per-device audit. The whole richness of a device is one table row.
- **Presence polling is invisible and jumpy.** Polls every 10s and replaces state wholesale (`setDevices(res.devices)`) — rows can reorder/flicker, "Last seen" jumps, and there's no "live" affordance, no subtle update animation, no stale-data indicator. No websocket despite `WS_BASE_URL` being defined.
- **Refresh is a manual secondary button** next to a search box — vestigial once polling exists, and it gives no feedback (no spinner, no "updated just now").
- **Missing states.** One combined loading row and one empty row. No error-with-retry inside the table, no offline/reconnecting banner, no per-row connecting skeleton beyond the button text, no "no results for '<query>'" vs "no devices at all" distinction.
- **Bulk / multi-select absent.** No select-all, no bulk actions, no keyboard navigation of rows, no row focus. A technician can't drive this from the keyboard.
- **Density and scannability.** Uniform `px-4 py-3`, monospace hostname is the same weight as everything, status badge and last-seen don't visually cluster. Hard to scan 200 devices.

### World-class version
A true **address book**: left tree of customers/sites/groups + favorites, main pane a dense, sortable, multi-select device list with OS glyphs, live presence dots, "in-session" indicator, tags, and inline quick-connect. Server-driven search/filter/sort (using the `q`/`status` params) plus a `⌘K` jump. A **device detail drawer** (`getDevice`) with session history, per-device audit, notes, and every connect path (unattended, request attended, wake). Live presence over websocket with subtle row updates, not full-list replacement. Skeleton rows, distinct empty vs no-results states, keyboard navigation.

---

## 6. Live Session — 3.5 / 10

File: `app/sessions/[id]/page.tsx`

The highest-stakes screen. It works functionally (video, input capture, clipboard, file, end) but the *design* undersells trust and control badly.

### Weaknesses
- **You cannot tell what you're connected to.** The header shows `Session 1a2b3c4d`, a status badge, a connection label, and `· type`. There is **no device name, no hostname, no OS, no end-user identity**. A technician controlling a machine should never have to wonder which machine. The `session.device_id` is fetched but never resolved to a device.
- **Trust indicators are minimal and static.** The red "REMOTE SESSION ACTIVE" bar is the one strong move — keep it. But it's the *only* trust signal. Missing: **session timer/duration** (despite `started_at` in the type and a `useCountdown` helper already built), **consent state** (was this approved? when?), **recording indicator** (is this session recorded? it's an audited product — say so), **attended vs unattended** made prominent, **banner-visible confirmation** (`session.banner_visible` exists in the type and is never shown — the whole product promise is "banner-enforced," yet the console never confirms the end user's banner is actually up), and **who else is viewing**.
- **Input control is a bare checkbox.** "Enable input control (mouse + keyboard)" as a raw `<input type=checkbox>` with an amber hint. This is the primary mode toggle of a remote-control tool — it deserves a clear view-only ↔ control segmented control with an unmistakable current-state indicator. As-is, whether you're controlling or observing is easy to lose track of.
- **No session toolbar.** Real remote tools have a control bar: fit/scale, actual size, fullscreen, monitor selector (multi-display), Ctrl-Alt-Del / special keys, quality/bandwidth, screen blank, lock remote input, reboot, annotate, chat. Here there is *nothing* over the video — just raw mouse/key capture and a checkbox. The video is `aspect-video w-full`; there's no fullscreen, no scaling control, no multi-monitor concept.
- **Clipboard/file/activity are three stacked generic cards.** Clipboard is one-way emphasis (button to send; received text in a readonly textarea) with no history. File send is a raw `<input type=file>` with the browser's default styling (the one place native file input shows through — looks unfinished) and no progress, no transfer list, no confirmation. "Activity" is a monospace `text-[11px]` console log — developer debug output, not a technician-facing event feed.
- **Connection/reconnection UX is thin.** States exist (`signaling/connecting/connected/closed/failed`) but surface only as a text label and a dim overlay ("waiting for the agent's screen…"). **Failed** has no retry button, no diagnostics, no ICE/relay info. The comment even notes ICE servers may be missing ("using host candidates only") — a likely-to-fail path with no recovery UI. No reconnecting spinner, no "attempting to reconnect" state.
- **"Enter permission"/consent-pending state is absent.** For an attended session the tech should see "Waiting for end-user to accept…" with the code and a cancel. There's no pending-consent screen; the page assumes the pipe is (or will be) live.
- **End-of-session is abrupt.** Ending flips the bar to gray and disables the button. No confirmation before ending, no summary ("session lasted 06:12, 2 files sent, log available"), no link to the session's audit record, no "reconnect / start new."
- **The screen is boxed in `max-w-7xl`.** The remote screen — the thing the technician stares at — is constrained to 80rem with a sidebar, never immersive. No fullscreen path.
- **Accessibility of the control surface.** `role="application"` on a `tabIndex=0` div is reasonable, but there's no visible focus/"captured" indicator, no instructions surfaced until input is on, and keyboard capture with `preventDefault` can trap users with no obvious escape.

### World-class version
A near-full-bleed viewer with a persistent, quiet **top control bar**: device identity (name · hostname · OS glyph), **live duration timer**, **view-only / control** segmented toggle, **consent + banner-verified** chip, **REC** indicator, monitor selector, fit/actual/fullscreen, special-keys menu, quality control, and a prominent End. A collapsible right panel with proper **clipboard sync (two-way, history)**, **file transfer with progress and a transfer list**, and a human-readable **session timeline** (connected, consent granted, input enabled, file sent) — not a debug log. First-class **connecting / reconnecting / failed-with-retry / consent-pending** states. An end-of-session summary that links straight to the audit trail.

---

## 7. Audit Log — 4.5 / 10

File: `app/audit/page.tsx`

The most competent screen — real cursor pagination, sensible filters, color-coded event types. Still far from enterprise-grade.

### Weaknesses
- **IDs are truncated to 8 chars with no way to see or copy the full value or pivot.** Session/Device/Technician columns show `1a2b3c4d` with no link, no copy, no "filter by this," no resolution to a human name. An auditor cannot go from an event to the device or session it references. `technician_id` never resolves to the technician's name even though the app knows technicians.
- **Metadata is raw `JSON.stringify`.** The most information-dense column dumps `{"foo":"bar"}` as one monospace string with no wrapping, no key/value formatting, no expand. This is the audit *evidence*, rendered as a debug blob.
- **Filtering requires typing UUIDs by hand.** Device ID and Session ID are free-text inputs expecting a `uuid` (placeholder literally says "uuid"). No pickers, no autocomplete, no "filter from a device/session page." Only `event_type` has a proper select.
- **No date/time range filter in the UI** despite `since`/`until` existing in `ListAuditParams`. Auditors filter by time first; it's missing.
- **No export.** Enterprise audit = CSV/JSON export, and ideally a signed/append-only attestation. There's no export button, no "download these results."
- **Pagination is prev/next only, count-per-page footer.** No total count, no page size control, no jump, no "newest/oldest" sort control (order is fixed). "50 events on this page" is weak wayfinding.
- **Event-type color mapping is arbitrary** (violet for device.register, amber as the catch-all incl. `input.command_attempt` — a security-sensitive event that should read as a *warning/danger*, not the same amber as clipboard.sync). Security-relevant events (`auth.login_failed`, `input.command_attempt`) should stand out; here they blend in.
- **No row detail.** Clicking a row does nothing. An audit event should expand to a full, readable record with all metadata, resolved entities, and IP/user-agent if present.
- **No real-time / live tail option** for an ops team watching sessions unfold.
- **Reuses the same hand-rolled table and generic error box** as Devices — inconsistency risk, and the same missing-states story (no distinct "no events at all" vs "no events for these filters," no error-with-retry).

### World-class version
Resolved, linked, copyable entities (technician name + avatar, device name, clickable session → detail). A humanized metadata renderer (key/value chips, expandable JSON). A proper filter bar with **date-range**, entity **pickers**, and severity — plus deep-linkable filter state in the URL. **Export (CSV/JSON)**. Severity-aware coloring that makes security events pop. Row-expand detail. Optional live tail. Totals and page-size control.

---

## Top 15 Problems, Ranked by Impact

1. **No global quick-connect / command palette.** The core promise ("technician-first, speed, 1–2 click session start") is unmet. Connecting requires navigating to a table and scanning. — *chrome / whole app*
2. **Live session hides what you're connected to and who consented.** No device name, no timer, no consent/recording/banner-verified indicators. `session.banner_visible` and `started_at` exist and are unused. This is a trust failure in a trust product. — *live session*
3. **No typographic or token system → the whole app reads "AI-generated."** No custom font, no type scale, no semantic color tokens, no light mode, stock SaaS-blue accent. — *foundation*
4. **Devices is a flat spreadsheet, not an address book.** No grouping, favorites, tags, saved views, server-side search, or device detail. `q`/`status`/`getDevice` all exist and are unused. — *devices*
5. **Dashboard leads with vanity KPIs, not action or live state.** Four template stat cards (one meaningless), core actions buried, no "active sessions now." — *dashboard*
6. **No component library depth.** No Modal, Toast, Tooltip, Menu, Tabs, Skeleton, EmptyState, icons. Errors are a copy-pasted red div on 4 screens. Guarantees drift. — *foundation*
7. **Session control surface is a bare checkbox with no toolbar.** No view-only/control clarity, no fullscreen, no multi-monitor, no special keys, no scaling. — *live session*
8. **No persistent active-session awareness in the chrome.** Navigate away from a live session and nothing shows it's still running or lets you rejoin. — *chrome*
9. **Reconnect / failed / consent-pending states are missing or text-only.** `failed` has no retry; likely-to-fail ICE path has no recovery UI; no pending-consent screen. — *live session*
10. **Audit is not usable as evidence.** Truncated unlinked IDs, raw JSON metadata, UUID-typing filters, no date range, no export. — *audit*
11. **Top-nav chrome caps the product.** A 3-link top bar is a marketing-site shape; the product needs a left rail with org switcher, search, teams, and a user menu. — *chrome*
12. **Login has no enterprise trust signals.** No SSO/MFA, no forgot-password, no "audited/consented" framing, no org/region. — *login*
13. **No loading skeletons or motion anywhere.** Values pop in via `…`; tables flash; polling replaces state and flickers. Feels static and unfinished. — *foundation / all*
14. **Attended-code flow is under-built.** No copy button, no QR, no outstanding-codes list — despite being one of two primary ways to start support. — *dashboard*
15. **Zero iconography and no OS glyphs.** A letter-in-a-box logo and text-only everything makes the app look unfinished next to any competitor. — *foundation*

---

## What's Actually Good and Worth Keeping

Being fair — the bones are healthier than the surface:

- **The mandatory, non-dismissible red "REMOTE SESSION ACTIVE" bar** (`sessions/[id]/page.tsx`) is genuinely the right instinct: unmissable, `role="status"`, `aria-live`, pulsing dot. Keep the concept; enrich it with identity + timer.
- **Accessibility fundamentals are present:** a consistent, visible focus-ring policy in `globals.css`; `aria-current` on active nav; `aria-label`s on inputs and the remote surface; `role="application"` on the control area; `role="alert"` on errors. A good baseline to build on.
- **The attended-code panel with a live `useCountdown`** is a real product idea and the one delightful, purpose-built moment. It just needs copy/QR/history.
- **The data/API layer is excellent and disciplined:** `lib/api.ts` is fully typed, no `any`, one function per endpoint, clean `ApiError` with codes, `AbortController` wired through. The UI under-uses it (`getDevice`, `q`/`status`, `since`/`until`, `banner_visible`, `started_at` all sit idle) — meaning most improvements are pure front-end, no backend blocked.
- **Sensible technician-safety gating logic** (`canConnect = online && unattended`) and thoughtful engineering touches (ICE servers stashed across navigation, `network_error` suppressed during polling, cursor-stack pagination that supports real back-paging).
- **Cursor-based audit pagination** is done properly, not offset-hacked.
- **Consistent dark, calm baseline.** It's not garish. The restraint is real; it just hasn't been shaped into a point of view yet.

**Bottom line:** The engineering substrate is strong and the safety instincts are right. What's missing is *design* — a typographic and token system, a component library, real situational-awareness and trust surfacing on the session screen, an address-book-grade devices experience, and a speed-first command layer. This is a 3.8 that can reach ~9 almost entirely through front-end work, because the API already exposes everything the redesign needs.
