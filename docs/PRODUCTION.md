# Production readiness checklist

Everything needed to run the Tiefixy platform for real customers. Items marked
**[code]** are already in the repo; **[server]** you (or the Chrome extension)
do on the VPS; **[console]** you do in the RustDesk Pro web console.

The VPS layout: repo at `/opt/remote-tool`, settings at
`/opt/remote-tool/infra/.env` (keep it `chmod 600` — it holds secrets), stack
run with `docker compose -f infra/docker-compose.prod.yml`.

---

## 1. Deploy the latest code  **[server]**

```bash
cd /opt/remote-tool/infra
git fetch origin && git reset --hard origin/claude/remote-support-mvp-0chwrz
docker compose -f docker-compose.prod.yml up -d --build backend console
```

All app services already use `restart: unless-stopped`, so the stack comes back
by itself after a VPS reboot.

---

## 2. Security  **[critical]**

| Item | Where | Why |
|------|-------|-----|
| Change the RustDesk admin password (off `admin`/`test1234`) | **[console]** | It's an open door on a public IP until you do |
| Keep secrets only in `infra/.env` (`chmod 600`) | **[server]** | API token, JWT secret, DB + TURN passwords never go in the repo |
| Put the RustDesk console behind HTTPS (below) | **[server]** | Today it's plain HTTP on `:21114` — credentials cross the wire unencrypted |
| Confirm `APP_ENV` is not `dev` | **[server]** | Strict mode rejects placeholder secrets |

### Optional: RustDesk console behind `rustdesk.tiefixy.com` (HTTPS)

Add a DNS `A` record `rustdesk` → your VPS IP, then append this to
`infra/Caddyfile` and reload Caddy. (The RustDesk web console listens on the
host at `:21114`; Caddy reaches the host via `host-gateway`.)

```caddy
rustdesk.{$DOMAIN} {
	encode gzip
	reverse_proxy host.docker.internal:21114
}
```

And add to the `caddy` service in `docker-compose.prod.yml`:

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Then: `docker compose -f infra/docker-compose.prod.yml up -d caddy`. Verify
`https://rustdesk.tiefixy.com` loads before you rely on it; if RustDesk runs in
its own Docker network instead of on the host, point `reverse_proxy` at that
container/name instead.

---

## 3. Multi-tenant grouping — the ONE concept that makes isolation real  **[console]**

The platform shows each technician only the machines in **their RustDesk group**
(group name == the technician's username). A machine with **no group is hidden
from technicians** (only the platform admin sees ungrouped machines). So for a
technician's customers to appear in *their* panel, those machines must land in
that technician's group.

**Important:** RustDesk's own device-to-group assignment is unreliable (a known
bug — devices baked with a group often still show up unassigned). So the
platform does the assignment itself, and it's the reliable path:

### Assign machines to technicians (in your dashboard)

1. A customer installs the branded client → the machine appears in the **admin**
   dashboard's "Unattended machines" list (admin sees all, including unassigned).
2. Next to each machine there's an **"Assign to \<technician\>"** dropdown
   (admin-only). Pick the technician who owns it.
3. That machine now shows **only** in that technician's dashboard
   (`<username>.tiefixy.com`) and nowhere else. The technician can rename/delete
   it; other technicians never see it.

This is enforced by the platform (a per-device owner in the database), so it
does not depend on RustDesk's flaky grouping. Optionally you can still put a
per-technician installer at `agent-dist/<username>.exe` for branding, but
ownership is what actually isolates tenants.

### How the code → right-client flow works (built)

- A customer opens **`tiefixy.com`** (the root is the customer code page; staff
  use `admin.<domain>` / `<username>.<domain>`) and enters a technician's code.
- The page validates the code (`/api/v1/connect/resolve`) — a wrong/expired code
  is rejected with a clear message.
- The download (`/api/v1/connect/download`) serves that technician's installer
  (`<username>.exe`) when present, else the generic `remote-agent.exe`.
- The customer runs it once → the machine lands in the technician's group → it
  appears in that technician's dashboard, and nowhere else.

So to onboard a technician: create their group, generate their client, drop it at
`agent-dist/<username>.exe`. Done.

> While you're the only user (admin), you already see everything, so per-tech
> installers only matter as you add technicians. Until a machine is grouped it
> shows only in the admin dashboard — the safe default, not a bug. The generic
> `remote-agent.exe` is the fallback for any code without a per-tech installer.

Alternative for a few machines: assign devices to groups manually in the console
(Devices → select → set group).

---

## 3b. The technician app (how a technician takes control)  **[console]**

A technician controls a remote PC with a **desktop app** they install on **their
own** computer. With RustDesk the same client both hosts and controls, so:

1. Generate a branded client named e.g. **"Tiefixy Console"** in the RustDesk
   client generator (server `200.97.171.196`, your key). No unattended password
   needed — this one is for *connecting out*.
2. Put it on the server as **`/opt/remote-tool/infra/agent-dist/console.exe`**.
3. Technicians download it from the dashboard **"Technician app"** button
   (served from your portal at `/api/v1/connect/technician-app`). If `console.exe`
   is absent, that button falls back to the generic client, which also connects.

To control a PC: open the technician app → type the machine's ID (shown in the
dashboard) → Connect → enter its permanent password → full screen + input.

---

## 3c. Connection-engine health — diagnosing "Failed to connect via rendezvous server"  **[code]**

If a technician ever sees **"Failed to connect via rendezvous server: Please
try later"**, that message is narrower than it looks. It is emitted only *after*
the technician's app has already connected to your server successfully. It means:
*"I reached the server, asked it three times over ~18 seconds to introduce me to
that machine, and got no answer."* Every other failure has different wording —
`Key mismatch`, `Remote desktop is offline`, `ID does not exist`, `Key overuse`,
or `Failed to connect **to** …` (note *to*, not *via*). So the key, the licence,
the ports and the firewall are all provably **not** the cause.

What it actually means: your server forwarded the request to the customer's PC
and waited, and **the customer's PC never called back**.

### What the dashboard now shows

The fleet list only proves the RustDesk *web console API* (port 21114) answers —
which says nothing about the ports a session needs. So the backend now probes
them directly and the admin dashboard has a **"Connection engine"** card:

| Port | What it does | Shown as |
|------|--------------|----------|
| 21115 | Works out the network type before connecting | Accepting connections / Nothing listening |
| 21116 | **Introduces the technician to the machine** (the one in the error) | ″ |
| 21117 | Carries the session when a direct link can't be made | ″ |

Plus a 24-hour strip (one cell per 15 minutes) and a list of past problems. When
a technician says *"it failed at 14:32"*, look at 14:32: green means the engine
was accepting connections and the fault was elsewhere (the customer's PC or a
network in between); red means the engine was the problem.

This is deliberately **not** wired into `/healthz` or `/readyz` — a RustDesk
blip must never mark the backend unhealthy and restart the container. Probe
interval is `RUSTDESK_PROBE_INTERVAL` (default `30s`); history is in memory, so
it resets if the backend restarts (the failures are also written to the backend
log, which survives).

> **"Last seen" now shows for online machines too.** The server keeps a machine
> marked online for 30 seconds after its last check-in, but the agent only
> checks in every 15 — so a machine can read **green while already
> unreachable**, which is precisely what produces this error. A green row with a
> stale "seen" is the tell.

### The two most likely causes, if it happens again

1. **Firewall rate-limiting on the VPS.** A `ufw limit` rule blocks a source IP
   after ~6 new connections in 30 seconds, then forgives itself. It is TCP-only,
   so the machine keeps showing green while the callback is dropped. Check with
   `sudo ufw status verbose | grep -i limit`.
2. **The customer's PC napping** — sleep, Modern Standby, or Windows powering
   down the network card. Worth adding `powercfg /change standby-timeout-ac 0`
   and unticking *"Allow the computer to turn off this device to save power"* on
   the network adapter to your standard agent-deployment checklist.

Note also that agents built with **"Disable TCP listen port"** must open a
brand-new outbound connection to your server for *every* session, which is why
anything that throttles new connections shows up as this error — and why a
second simultaneous session is the first thing to fail.

---

## 4. Backups  **[server]**

A backup script is included (`infra/backup.sh`): nightly gzipped `pg_dump` with
14-day retention.

```bash
chmod +x /opt/remote-tool/infra/backup.sh
(crontab -l 2>/dev/null; echo "30 2 * * * /opt/remote-tool/infra/backup.sh >> /var/log/remote-backup.log 2>&1") | crontab -
# test it once now:
/opt/remote-tool/infra/backup.sh && ls -lh /opt/remote-tool/backups
```

Restore instructions are in the header of `backup.sh`. Also back up
`infra/.env` somewhere safe (offline) — losing `JWT_SECRET` logs everyone out;
losing the RustDesk license/key means re-licensing.

---

## 5. Verify end-to-end  **[you]**

1. Install the branded client on a test PC → it appears **online** in the
   dashboard within ~30s.
2. From a second machine with the app, connect to that PC's ID + permanent
   password → you can see and control the screen.
3. Create a technician in `admin.tiefixy.com` → log in at
   `username.tiefixy.com` → confirm they see only their own machines.
4. Stop RustDesk briefly → confirm the dashboard still loads (fleet box shows
   "temporarily unavailable", devices/sessions unaffected).
5. Reboot the VPS → confirm the whole stack comes back on its own.

---

## Status summary

| Area | State |
|------|-------|
| App auto-restart after reboot | ✅ code (`unless-stopped`) |
| HTTPS for the platform (tiefixy.com + tenants) | ✅ code (Caddy on-demand TLS) |
| Tenant data isolation in the API | ✅ code (group-scoped fleet + sessions/audit) |
| Graceful degradation if RustDesk is down | ✅ code |
| DB backups | ✅ code (`backup.sh`) — **needs the cron installed [server]** |
| Connection-engine port monitoring (21115/21116/21117) | ✅ code (admin dashboard card) |
| RustDesk console password + HTTPS | ⏳ **[console/server]** |
| Per-technician grouping | ⏳ **[console]** as you add technicians |
| End-to-end connect test | ⏳ **[you]** |
