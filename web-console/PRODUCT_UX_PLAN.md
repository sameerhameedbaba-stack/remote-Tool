# Product UX Plan — Remote Support Console

Technician-first, trust-first information architecture and the key journeys, with
the click-budget targets each is designed to hit.

## 1. Information architecture

```
Console (authenticated shell: sidebar + top bar + ⌘K command palette)
├── Dashboard            command center — metrics, quick connect, attended code, online devices
├── Devices              address book — search, filters, table/cards, favorites, detail drawer
│   └── Device drawer    identity, status, permissions, recent sessions + audit, actions
├── Audit log            timeline + table, filters, severity, export (placeholder)
├── Administration
│   ├── Technicians      members, roles, MFA (placeholder — needs admin API)
│   ├── Reports          duration / activity / usage / billing (placeholder — needs aggregation API)
│   └── Settings         appearance (live), security, session/recording/retention policy, branding
└── Live session         full-bleed: trust bar + canvas + toolbar + right panel  (own chrome, no sidebar)
```

The **shell** (`components/shell/AppShell.tsx`) renders sidebar + top bar for app
pages, but stays out of the way on **login** (owns the viewport) and the **live
session** (canvas must dominate).

The **⌘K command palette** is the global accelerator: search a device and press
Enter to connect, or jump to any page — available from every screen.

## 2. Journeys (with click budgets)

### A. Attended support (technician issues a code)
1. Dashboard → type a label → **Create code** (1 click). Code shows with a live
   expiry countdown + Copy. Read/paste it to the end user. **Target: ≤2 clicks.**

### B. Unattended access (connect to a known device)
- **From dashboard:** Online devices list → **Connect** (1 click). → live session.
- **From ⌘K:** ⌘K → type name → Enter. → live session.
- **From devices:** row → **Connect** (1 click). **Target: ≤2 clicks. ✅**

### C. Device search
- ⌘K opens instantly; server-side `q` search as you type.
- Devices page: search box focused first; filter chips (Online/Offline/Favorites/
  Windows/macOS/Linux); table or card view; favorites pinned via ★.
  **Target: search reachable within 1s of page load. ✅**

### D. Starting a live session
- Connect (see B) → session screen shows **Connecting → Awaiting consent →
  Connected**, each as an explicit overlay. Trust bar shows device, timer,
  consent, technician, connection quality throughout.

### E. File transfer
- Session → toolbar **Files** (or ⌥/panel) → drop/pick a file → queue shows
  per-file status (queued/sending/sent/failed). **Executable extensions
  (.exe/.msi/.bat/.ps1/.sh/.cmd/.scr) trigger a warning + explicit confirm.**

### F. Ending a session
- Toolbar **End** (red, grouped away from other actions) → **ConfirmDialog** →
  both peers notified, event audited. Also `⌥E`.

### G. Reviewing audit
- Audit log → filter by event type / device / session → Timeline (grouped by day,
  severity badges) or Table. Every session lifecycle + data action is present.

### H. Managing technicians
- Admin → Technicians: your profile + roles/MFA structure. Invite/list/roles are
  gated on a technician-management API (clearly marked backend TODO).

## 3. Trust & anti-abuse UX (always visible in-session)

The live session surfaces, at all times: **REMOTE SESSION ACTIVE** (mandatory,
non-dismissible), the **device being controlled**, **consent state**
(awaiting/confirmed, driven by the agent's banner ack), **session timer**,
**technician identity**, **connection quality**, and — when engaged — **recording**,
**input-locked**, and **screen-locked** indicators. There is no hidden/silent
mode. Destructive actions require confirmation.

## 4. Responsive behavior

- Desktop-first; verified premium at 1440×900 and usable at 1366×768.
- Sidebar collapses under `lg`; a mobile nav drawer replaces it.
- Dashboard/devices/audit reflow to single column on small screens.
- Live session prioritizes the canvas; the right panel hides under `md`.

## 5. Measured targets (met)

- Attended session from dashboard: **1–2 clicks.** ✅
- Unattended session from devices/⌘K: **≤2 clicks.** ✅
- Device search visible instantly (⌘K + focused search). ✅
- Critical session actions always visible; dangerous actions confirmed. ✅
- Every page has loading/empty/error states; every icon button has a tooltip. ✅
- Every status shows icon + text + color. ✅
