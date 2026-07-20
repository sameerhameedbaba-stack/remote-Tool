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

The reliable way with RustDesk Pro:

1. For each technician (say username `alice`), in the console create a **group
   `alice`**.
2. Generate a **branded client per technician** in the Client Generator with
   that technician's group baked in (app name "Tiefixy Support", server
   `200.97.171.196`, your key, unattended password ON, **assign to group
   `alice`**).
3. Give that installer to `alice`; every machine that runs it lands in group
   `alice` and shows up in `alice.tiefixy.com`'s dashboard — and nowhere else.

> While you're the only user (admin), you already see everything, so this only
> becomes necessary as you add technicians. Until a machine is grouped, it shows
> only in the admin dashboard — that's the safe default, not a bug.

Alternative for a few machines: assign devices to groups manually in the console
(Devices → select → set group).

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
| RustDesk console password + HTTPS | ⏳ **[console/server]** |
| Per-technician grouping | ⏳ **[console]** as you add technicians |
| End-to-end connect test | ⏳ **[you]** |
