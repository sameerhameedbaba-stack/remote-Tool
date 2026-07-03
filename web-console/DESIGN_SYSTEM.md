# Design System — Remote Support Console

A premium, enterprise design system for a remote-support/remote-desktop product.
Benchmark quality: Apple.com restraint, Google functional-color clarity, Stripe
polish, Linear sharpness. **Dark-first** (technicians work long sessions), with a
first-class Apple-style light mode.

Principle: **80% neutral premium foundation, 20% functional accent/status color.**

## 1. Tokens

All tokens are CSS variables (`app/globals.css`) mapped to Tailwind utilities
(`tailwind.config.ts`), so one component layer serves both themes. Switching
`data-theme` on `<html>` swaps every value.

### Surfaces
| Token | Dark | Light | Tailwind |
|-------|------|-------|----------|
| Page background | `#0B0D12` | `#F5F5F7` | `bg-app` |
| Main surface | `#111318` | `#FFFFFF` | `bg-surface` |
| Elevated surface | `#1A1D24` | `#FBFBFD` | `bg-surface-raised` |
| Card surface | `#20232B` | `#FFFFFF` | `bg-surface-card` |
| Hover | `#262A33` | `#F0F0F3` | `bg-surface-hover` |

### Text
| Token | Dark | Light | Tailwind |
|-------|------|-------|----------|
| Primary | `#F5F5F7` | `#1D1D1F` | `text-fg` |
| Secondary | `#B9BDC7` | `#6E6E73` | `text-fg-secondary` |
| Muted | `#8E94A3` | `#86868B` | `text-fg-muted` |

### Lines
`--line` (`#2B2F38` / `#D2D2D7`) → `border-line`; `--line-soft`
(`#343945` / `#E5E5EA`) → `border-line-soft`.

### Accent (primary action + active session)
`--accent` (`#0A84FF` dark / `#0071E3` light), `--accent-hover`
(`#409CFF` / `#005BB5`), `--accent-fg` white, `--accent-soft` subtle fill.
Tailwind: `bg-accent`, `text-accent`, `hover:bg-accent-hover`, `bg-accent-soft`.

### Functional status (Google discipline)
Each has a solid and a `-soft` tinted background. **Rule: never color alone —
every status renders icon + text + color.**

| Meaning | Token | Usage |
|---------|-------|-------|
| Info / active connection | `info` | signaling, neutral notices |
| Success / online / connected | `success` | online devices, active sessions, consent confirmed |
| Warning / pending / weak network | `warning` | pending sessions, failed sign-in, weak link |
| Danger / disconnect / destructive | `danger` | end session, offline errors, dangerous files |
| Neutral / offline | `neutral` | offline, ended, inactive |

## 2. Typography

Premium **system stack** (SF Pro on macOS, Segoe UI on Windows, Roboto on
Linux/Android) — no web-font fetch, so the build is hermetic and text renders
natively-crisp. Mono stack for IDs/codes/metadata.

Scale (tight, Apple-like tracking on headings):
- Page title `text-2xl` (24px) semibold, `tracking-tight`
- Section heading `text-[15px]` semibold
- Body `text-sm` (14px) / `text-[13px]`
- Meta/labels `text-[12px]` / uppercase `text-[11px] tracking-wider` for table
  headers and section eyebrows
- Numbers use `tabular-nums` (metrics, timers, latency)

## 3. Spacing, radius, elevation, motion

- **Spacing**: 4px base; page gutters `px-6 py-7`; card padding `p-4`/`p-5`.
- **Radius**: controls `rounded-lg` (8px), cards `rounded-xl` (12px), modals
  `rounded-2xl` (16px), pills `rounded-full`.
- **Elevation** (restrained, 3 levels): `shadow-elev-1` (rest), `shadow-elev-2`
  (hover/raised), `shadow-pop` (overlays). No decorative shadows or glows.
- **Motion**: 120–200ms, `ease-premium` (`cubic-bezier(0.22,1,0.36,1)`).
  `animate-fade-in`, `animate-scale-in`, `animate-slide-in-right`,
  `animate-pulse-ring` (live dot). Respects `prefers-reduced-motion`.

## 4. Iconography

`lucide-react` (stroke icons, per-icon imports — tree-shaken). OS glyphs
(Windows/macOS/Linux) are hand-drawn monochrome SVGs (`components/domain/os.tsx`)
so they inherit token color and stay crisp small. **Every icon-only button has an
`aria-label` and a `Tooltip`.**

## 5. Component states (mandatory)

Every list/data surface implements: **Loading** (shimmer skeleton rows),
**Empty** (icon + title + guidance + optional action), **Error** (icon + message
+ retry), plus domain states on the session screen: connecting, negotiating,
awaiting-consent, connected, weak-network, reconnecting, failed, ended.

## 6. Anti-patterns (explicitly avoided)

No gradient soup, no glassmorphism-for-decoration, no rainbow UI, no neon, no
default-shadcn look, no meaningless dashboard cards, no color-only status, no
shadows-as-decoration, no text below 12px, no icon buttons without labels.

## 7. Do / Don't for color

- Blue = primary action and the active session. **Only.**
- Green = healthy/online/connected/consent. **Only.**
- Yellow = warning/pending/weak network. **Only.**
- Red = destructive/failed/disconnect. **Only.**
- Gray = inactive/offline/neutral.
- Destructive actions (End session, Reboot, Send executable) are red **and**
  confirmed via `ConfirmDialog`.
