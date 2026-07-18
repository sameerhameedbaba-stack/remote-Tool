# Phase 3 — Wiring RustDesk behind the platform

This is the runbook for connecting your **RustDesk Server Pro** engine to the
`tiefixy.com` platform so it "looks like your platform": branded client,
9-digit codes, and a per-technician fleet view (online/offline).

The platform code is built. What's left are a few things only you can do in the
**RustDesk Pro web console** (the server side) plus dropping four values into the
`.env` file. Do these in order.

> **Secrets:** the API token and server key are secrets. They live only in the
> server's `.env` file (`chmod 600`). They are **never** committed to the repo.

---

## 0. Secure the console first (do this now)

Your Pro console is reachable at `http://<server-ip>:21114` with the default
`admin` / `test1234`. **Log in and change the admin password before anything
else.** This is an open door until you do.

---

## 1. Collect four values from the console

| Value | Where to find it | Goes into `.env` as |
|-------|------------------|---------------------|
| **API URL** | Your console origin | `RUSTDESK_API_URL` = `http://<server-ip>:21114` |
| **API token** | Console → your account / **Settings → API / Tokens** → generate a token | `RUSTDESK_API_TOKEN` |
| **Server ID** | The ID/relay host clients point at (usually the server IP) | `RUSTDESK_SERVER_ID` |
| **Public key** | Console → **Settings → the server key** (the `...=` string) | `RUSTDESK_PUBLIC_KEY` |

Paste them into `/opt/remote-support/.env` on the server:

```env
RUSTDESK_API_URL=http://200.97.171.196:21114
RUSTDESK_API_TOKEN=<the token you generated>
RUSTDESK_SERVER_ID=200.97.171.196
RUSTDESK_PUBLIC_KEY=<the server key, ends with ->
```

Then restart the backend:

```bash
docker compose -f infra/docker-compose.prod.yml up -d backend
```

The moment the token is set, the **"Unattended machines"** card on every
technician dashboard stops showing "not connected" and starts listing real
machines with live on/off status.

---

## 2. Generate your branded client (Basic plan includes this)

In the console: **Settings → (Custom) Client / Client Generator**.

Set:

| Field | Value |
|-------|-------|
| App name | **your brand** (e.g. "Tiefixy Support") — not "RustDesk" |
| ID / Relay server | `200.97.171.196` |
| Key | your server public key |
| Permanent password / unattended | enable (so a machine stays reachable) |
| Remove `Settings` from client | optional — locks the server in |

Download the generated `.exe`. That is your **branded client** — it is
pre-wired to your server, so when a host runs it, it shows up in your console
(and in the technician panel) automatically.

---

## 3. Serve the branded client from the connect page

Copy the branded `.exe` onto the server where the connect page serves it:

```bash
# on the server
cp your-branded-client.exe /opt/remote-support/infra/agent-dist/remote-agent.exe
```

The connect flow already downloads that file. So:

```
Host opens  tiefixy.com/connect  →  enters the 9-digit code
        →  downloads YOUR branded client  →  runs it once
        →  appears in the technician's "Unattended machines" list (online)
        →  technician clicks Connect
```

For **permanent/unattended** machines, the host just keeps the client installed —
it stays in the list even after reboot, exactly like ScreenConnect.

---

## 4. Per-technician isolation (grouping)

So each technician sees only their own machines, tag devices into a RustDesk
**group named after the technician's username** (the same username as
`username.tiefixy.com`). The platform filters the fleet view by that group.

- In the console: **Groups** / **Address Book** → create a group per technician
  username → assign each machine to the right group.
- The platform's `GET /api/v1/fleet` passes the logged-in technician's username
  as the group filter, so isolation is automatic once machines are grouped.

> If you don't group machines, every technician sees the whole fleet. Grouping is
> what makes it multi-tenant.

---

## What the platform already does (no action needed)

| Piece | Status |
|-------|--------|
| Backend RustDesk API client (device list + presence) | ✅ built |
| `GET /api/v1/fleet` — per-tenant, admin sees all | ✅ built |
| Dashboard "Unattended machines" card (live on/off) | ✅ built |
| `GET /api/v1/connect/info` — server info for connect page | ✅ built |
| Graceful "not connected" until token is set | ✅ built |
| `.env` plumbing for all four values | ✅ built |

## What needs you (console side)

| Step | You do it in |
|------|--------------|
| Change default password | Pro console |
| Generate API token | Pro console |
| Generate branded client | Pro console client generator |
| Drop branded `.exe` on server | server shell |
| Group machines by technician username | Pro console |
