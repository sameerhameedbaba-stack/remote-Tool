# Remote Support — Web Console

Next.js (App Router) + TypeScript + Tailwind technician console for the Remote
Support MVP. It authenticates technicians, lists devices and presence, starts
attended/unattended sessions, drives the WebRTC remote-view + input/clipboard/
file data channels, and browses the audit log. It conforms to the authoritative
contract in [`../docs/API.md`](../docs/API.md).

## Requirements

- Node 22
- npm

## Environment variables

Only browser-safe `NEXT_PUBLIC_*` values are used (no secrets). Defaults are
sensible for local dev against the compose backend.

| Variable                   | Default                 | Purpose                                  |
| -------------------------- | ----------------------- | ---------------------------------------- |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8080` | REST base URL of the Go backend.         |
| `NEXT_PUBLIC_WS_BASE_URL`  | `ws://localhost:8080`   | WebSocket base URL for signaling.        |

Set them in `.env.local` (git-ignored) for local dev, e.g.:

```
NEXT_PUBLIC_API_BASE_URL=http://localhost:8080
NEXT_PUBLIC_WS_BASE_URL=ws://localhost:8080
```

The canonical example lives in the repo root [`.env.example`](../.env.example).

## Commands

```bash
npm install      # install dependencies
npm run dev      # dev server on http://localhost:3000
npm run build    # production build (must pass)
npm run start    # serve the production build
```

## Page map

| Route             | Purpose                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `/login`          | Email + password → `POST /api/v1/auth/login`; stores JWT, redirects to `/dashboard`.      |
| `/dashboard`      | Online-device / session counts + "Start attended session" (`POST /api/v1/attended/codes`) with a live expiry countdown. |
| `/devices`        | `GET /api/v1/devices` table with presence polling; "Connect" starts an unattended session. |
| `/sessions/[id]`  | WebRTC viewer: signaling WS, offer/answer/ICE, video track, input/clipboard/file channels, mandatory active-session indicator, "End session". |
| `/audit`          | `GET /api/v1/audit` with filters + cursor pagination.                                      |

## Structure

```
app/                 App Router pages + layout + globals.css
components/           NavBar + shared UI (badges, countdown)
lib/api.ts           Typed API client (one fn per endpoint, no `any`)
lib/auth.tsx         Auth context + RequireAuth route guard
lib/signaling.ts     Typed WS signaling envelopes
lib/webrtc.ts        RTCPeerConnection + data-channel client
```

## Notes / MVP tradeoffs

- **Token storage.** The JWT is held in React context (in-memory) and mirrored
  to a non-`httpOnly` cookie so a reload rehydrates the session. This is
  readable by JS and therefore XSS-exposed; hardening to a backend-set
  `httpOnly` cookie is tracked in the ROADMAP. See `lib/auth.tsx`.
- **ICE servers.** `POST /api/v1/sessions` returns the ICE server list, carried
  to the session page via `sessionStorage`. On a cold open (reload / new tab)
  with no stashed list, the viewer falls back to the `ice_servers` field on
  `GET /api/v1/sessions/{id}`; the stash is cleared when the session ends. See
  `lib/session-connect.ts`.
- **Screen render is real** when the agent publishes a video track; the console
  is the offerer with a `recvonly` video transceiver. Input/clipboard/file
  senders emit protocol JSON over their data channels exactly as specified.

## Further reading

- [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) — tokens, color rules, component states.
- [`FRONTEND_ARCHITECTURE.md`](FRONTEND_ARCHITECTURE.md) — layering, data flow, a11y.
- Point-in-time UI redesign artifacts are archived under
  [`../docs/history/`](../docs/history/).
```
