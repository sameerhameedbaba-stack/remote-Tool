# One-click connect (`connect.<domain>`)

The easiest way to start a session with someone: they open a web page, type a
9-digit code, run the file it hands them, and you get control. No install, no
enrollment token, no typing URLs into a terminal.

This is the **attended** flow (like TeamViewer QuickSupport / AnyDesk). It sits
on top of the attended-code machinery the backend already had; the connect page
is the friendly front door for it.

## How it works

1. **You** (technician) click **Create code** on the dashboard → a one-time,
   short-lived **9-digit code** appears. The dashboard also shows the address to
   send the user: `connect.<your-domain>`.
2. **The user** opens `https://connect.<your-domain>`, types the code, clicks
   **Connect**.
3. The page downloads the agent named
   `RemoteSupport--connect.<your-domain>--<code>.exe`. The agent reads the
   **server host and the code out of its own file name**, so when the user runs
   it, it joins your session automatically — nothing to configure.
4. A **red consent banner naming you** appears on their screen; you see their
   screen in the console and can drive input. Everything is audited. Closing the
   window ends the session.

Nothing secret is embedded in the download: the code is single-use and expires,
and the host is public. The same generic binary is served to everyone — only the
file *name* differs per download.

## One-time setup on the server

The production stack (`infra/docker-compose.prod.yml` + `infra/Caddyfile`) already
serves the connect subdomain. Two things must be in place:

1. **DNS** — add an `A` record for `connect.<your-domain>` pointing at the same
   VPS IP as the apex. Caddy provisions its TLS certificate automatically on the
   first request.

2. **The download binary** — the connect page serves `remote-agent.exe`, a
   Windows build produced by CI. `infra/deploy.sh` fetches it from the latest
   GitHub release into `infra/agent-dist/`. So a release must have published
   `remote-agent.exe` as an asset (the Windows CI workflow attaches both the
   installer and the raw `remote-agent.exe` on every tagged release). If the
   asset isn't there yet, the console and the unattended installer still work;
   only the one-click download 404s until you publish a release and re-run
   `deploy.sh`.

## Troubleshooting

- **`connect.<domain>` doesn't load / certificate warning** — the `connect`
  DNS A record is missing or hasn't propagated. Confirm it resolves to the VPS,
  then reload after a minute (Caddy needs one request to fetch the cert).
- **The download 404s** — `infra/agent-dist/remote-agent.exe` isn't present.
  Publish a release so CI attaches `remote-agent.exe`, then re-run
  `infra/deploy.sh` (it fetches the asset). Check
  `docker compose -f docker-compose.prod.yml logs caddy`.
- **"Windows protected your PC" on run** — expected; the binary isn't code-signed
  yet. Click **More info → Run anyway**.
- **The app opens then says "Could not connect"** — the code likely expired or
  was already used. Create a fresh code and send a new download link.
- **"invalid code" / it rejects the code** — codes are single-use and expire
  (default 5 min). Generate a new one.

## Why a separate subdomain

Besides being a clean front door, `connect.<domain>` is a freshly-provisioned
host: a machine that had the apex domain cached to an old IP still looks the new
subdomain up from scratch, so the one-click path isn't blocked by stale DNS.
