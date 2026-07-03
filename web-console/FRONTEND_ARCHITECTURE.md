# Frontend Architecture — Remote Support Console

Next.js 15 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS. The
redesign is a **presentation-layer refactor**: the API client, auth, and WebRTC
logic were preserved; a design-token layer + a reusable component library were
introduced and every page was rebuilt on top of them.

## 1. Layering

```
app/*                     route pages (thin — compose components, own data fetching)
components/shell/*         AppShell, Sidebar, TopBar, CommandPalette, RelayHealth
components/ui/*            design-system primitives (theme-agnostic, reusable)
components/domain/*        product widgets (OS icons, audit metadata, device drawer, admin)
components/session/*       live-session chrome (top bar, toolbar, right panel, overlay)
lib/*                      api client, auth context, webrtc client, theme, cn, favorites
```

## 2. Design-token system

- `app/globals.css` defines semantic CSS variables for **dark** (`:root`) and
  **light** (`:root[data-theme="light"]`).
- `tailwind.config.ts` maps them to utilities (`bg-surface`, `text-fg-secondary`,
  `border-line`, `bg-accent`, `text-success`, …). Components never hard-code hex.
- `lib/theme.tsx` — `ThemeProvider` + `themeInitScript` (applied in `<head>` to
  prevent theme flash), persisted to `localStorage`, default dark.
- `lib/cn.ts` — `clsx` + `tailwind-merge` for conflict-safe class composition.

## 3. Reusable component library (`components/ui`)

Primitives: `Button`, `IconButton` (label required), `Card`, `SectionHeading`,
`Input`/`Textarea`/`Select`/`Field`, `Kbd`, `Spinner`, `Skeleton`, `Divider`.
States: `EmptyState`, `LoadingState`, `ErrorState`, `Alert`.
Overlays: `Modal`, `ConfirmDialog`, `Drawer`, `Tooltip` — all focus-trapped,
Escape-closable, scroll-locked, and focus-restoring (`useDialogA11y`).
Status: `StatusBadge`, `StatusDot`, `PresenceBadge`, `SessionBadge`, `ModeBadge`,
`PermissionBadge`, `ConnectionQualityIndicator` (all icon + text + color).
Data: `MetricCard`, `Tabs`. Formatting: `formatTime`, `timeAgo`, `useElapsed`,
`useCountdown`.

Domain/shell/session: `AppShell`, `Sidebar`, `TopBar`, `CommandPalette`,
`RelayHealthPill`, `OsIcon`, `AUDIT_META`, `DeviceDetailDrawer`, `SessionTopBar`,
`SessionToolbar`, `SessionRightPanel`, `ConnectionOverlay`, admin scaffolding.

## 4. Data & state

- Server data via the existing typed `lib/api.ts` (`listDevices` with `q`,
  `getDevice`, `createSession`, `createAttendedCode`, `listSessions`, `listAudit`
  with cursor pagination). No new endpoints invented; gaps are marked TODO.
- Local component state only (React hooks) — no global store needed. Auth token
  via `lib/auth` context; theme via `lib/theme` context; favorites via
  `lib/favorites` (localStorage until a server address book exists).
- Presence/data refresh via light polling (10s on dashboard/devices), matching
  the backend's 30s presence TTL.

## 5. Accessibility

Strict-typed, no `any` in the component library. Focus-visible rings on all
interactive elements; dialogs/drawers trap focus and restore it; every icon
button has `aria-label`; status is never color-only; `role="status"`/`"alert"`
used appropriately; keyboard shortcuts (`⌘K`, `⌥I`, `⌥E`, `F`) with field guards;
reduced-motion honored.

## 6. Performance & build

- System fonts (no web-font network dependency) → hermetic, fast build.
- `lucide-react` per-icon imports; standalone Next output for a small container.
- `next build` passes clean (types + lint) for all 11 routes.

## 7. Preserved behavior / compatibility

- `lib/webrtc.ts`, `lib/signaling.ts`, `lib/api.ts`, `lib/auth.tsx` unchanged
  except the additive `Device.app_version` field.
- E2E anchors kept: `#email`/`#password`/`[role=alert]` (login), the
  `aria-label="Session label"` + "Create code" + `aria-label^="Attended code"`
  flow (dashboard), "Online" presence text (devices), the "REMOTE SESSION ACTIVE"
  indicator (session). The audit E2E selector was updated to the new
  `data-testid="audit-row"` markup.

## 8. Backend-dependent placeholders (marked in code)

Relay per-node metrics, device public IP, resolution/FPS, technician
management (list/invite/roles), reports aggregation, CSV export, server-synced
notes, chat data channel, recording/lock/disable-input controls, session/
retention policy. Each is visibly labeled (no fake data).
