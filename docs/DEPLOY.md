# Deploying Remote Support to the public internet

This turns the project into a **real tool you can use with a remote friend**: a
public backend + console over HTTPS, and a TURN relay so the screen/keyboard
connection works across home networks (NAT).

Because it's a browser-based remote-desktop tool, **TLS (HTTPS/WSS) is
mandatory** — browsers won't do WebRTC or store the session otherwise. That
means you need a **domain**. There is no way around this (even AnyDesk/TeamViewer
run their own TLS servers).

## What you need (one-time)

1. **A small Linux VM** (Ubuntu 22.04/24.04). ~$4–6/mo: Hetzner, DigitalOcean,
   Vultr, Linode, etc. 1 vCPU / 1–2 GB RAM is enough for a test.
2. **A domain name** (~$1–12/yr) — or a subdomain you control.
3. Open these ports on the VM firewall / cloud security group:
   - `80/tcp`, `443/tcp` → Caddy (web + TLS)
   - `3478/tcp`, `3478/udp` → TURN
   - `49160-49200/udp` → TURN relay range

## Step 1 — Point your domain at the VM

Create a **DNS A record**: `support.example.com → <your VM's public IP>`.
Wait for it to resolve (`ping support.example.com` shows the VM IP).

## Step 2 — Install Docker on the VM

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker   # run docker without sudo
```

## Step 3 — Get the code + configure

```bash
git clone https://github.com/sameerhameedbaba-stack/remote-Tool.git
cd remote-Tool

cp .env.prod.example infra/.env
# Generate strong secrets:
echo "JWT_SECRET=$(openssl rand -hex 32)"
echo "AGENT_ENROLLMENT_TOKEN=$(openssl rand -hex 32)"
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)"
echo "TURN_PASSWORD=$(openssl rand -hex 32)"

nano infra/.env    # set DOMAIN, PUBLIC_IP, ACME_EMAIL, SEED_TECH_*,
                   # and paste the four secrets above
```

Set at minimum: `DOMAIN`, `PUBLIC_IP` (the VM's public IP), `ACME_EMAIL`,
`POSTGRES_PASSWORD`, `JWT_SECRET`, `AGENT_ENROLLMENT_TOKEN`, `TURN_PASSWORD`,
`SEED_TECH_EMAIL`, `SEED_TECH_PASSWORD`. Leave `APP_ENV` unset (strict mode).

## Step 4 — Launch

```bash
cd infra
docker compose -f docker-compose.prod.yml up -d --build
```

Caddy fetches a Let's Encrypt certificate automatically (needs Step 1 done and
ports 80/443 open). Watch it come up:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f caddy backend
```

Verify:
```bash
curl https://support.example.com/healthz     # -> ok
curl https://support.example.com/readyz       # -> ok (DB + Redis reachable)
```

Then open **https://support.example.com** and log in with `SEED_TECH_EMAIL` /
`SEED_TECH_PASSWORD`.

> Note: `NEXT_PUBLIC_*` are baked into the console image at build time, so if you
> change `DOMAIN` later, rebuild: `docker compose -f docker-compose.prod.yml up -d --build console`.

## Step 5 — Put the agent on your friend's Windows PC

Give your friend the installer (see `installer/README.md` for the download) and
these three values:

- **Backend API URL:** `https://support.example.com`
- **WebSocket URL:** `wss://support.example.com`
- **Enrollment token:** your `AGENT_ENROLLMENT_TOKEN`

They run the installer, enter those, and finish. The agent enrolls and starts.
When a session begins, **a red consent banner appears on their screen naming
you** — they always see that it's happening; there is no silent mode.

## Step 6 — Connect

1. On **https://support.example.com** (logged in as the technician), open
   **Devices** — your friend's PC shows up **Online**.
2. Click **Connect**. Their screen appears; enable **input control** to drive
   mouse + keyboard.
3. Every session start/end, file transfer, and input is written to the **Audit**
   log.

## Attended (one-off) sessions — no install (recommended)

The easiest path: on the dashboard click **Create code**, send your friend
**`https://connect.<your-domain>`**, they enter the code and run the file it
downloads — you get control. No install, no token. Add a DNS `A` record for
`connect.<your-domain>` → the VM first. Full details and troubleshooting in
[docs/CONNECT.md](CONNECT.md).

(A terminal alternative also exists: `remote-agent.exe portable` prompts for the
code. Same consent banner applies to both.)

---

## Quick, no-domain test (less reliable)

If you just want to try it fast without a domain, you can run the **dev** stack
locally (`docker compose -f infra/docker-compose.yml up`) and expose it with a
tunnel (e.g. Cloudflare Tunnel / ngrok) to get a temporary HTTPS URL. Caveat:
tunnels forward HTTP/WS but **not** the TURN UDP ports, so the WebRTC connection
only works if both networks are STUN-friendly — it may fail behind stricter
NATs. The VM + domain path above is the reliable one.

## Troubleshooting

- **Cert not issued / 443 fails:** DNS must point at the VM and ports 80+443 must
  be open before launch. `docker compose logs caddy` shows ACME progress.
- **Device shows Online but the screen never appears:** almost always TURN — make
  sure `PUBLIC_IP` is correct and UDP `3478` + `49160-49200` are open. Check
  `docker compose logs coturn`.
- **Backend won't start, "placeholder value":** a secret still says `change-me`
  or `REPLACE-…`. Strict mode rejects it — set a real value.
- **Agent can't connect (TLS):** the agent validates certificates; use the real
  `https://`/`wss://` domain (a self-signed cert will be rejected).
