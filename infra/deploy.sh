#!/usr/bin/env bash
# One-command production deploy for the Remote Support tool.
#
# Run this on a fresh Ubuntu VPS (as root). It:
#   1. installs Docker (if missing),
#   2. clones/updates the repo to /opt/remote-tool,
#   3. generates strong secrets and writes infra/.env (only on first run —
#      re-runs keep your existing secrets so logins stay stable),
#   4. brings the stack up with HTTPS (Caddy + Let's Encrypt) and TURN,
#   5. opens the firewall ports (if ufw is active),
#   6. prints your console URL, login, and the agent enrollment token.
#
# Usage (as root):
#   curl -fsSL https://raw.githubusercontent.com/sameerhameedbaba-stack/remote-Tool/claude/remote-support-mvp-0chwrz/infra/deploy.sh \
#     | DOMAIN=tiefixy.com bash
#
# Prereqs: DOMAIN's DNS A record already points at this VPS's public IP, and
# ports 80,443,3478(tcp+udp),49160-49200(udp) are reachable.

set -euo pipefail

REPO_URL="https://github.com/sameerhameedbaba-stack/remote-Tool.git"
REPO_BRANCH="claude/remote-support-mvp-0chwrz"
APP_DIR="/opt/remote-tool"
DOMAIN="${DOMAIN:?Set DOMAIN, e.g. DOMAIN=tiefixy.com}"
ACME_EMAIL="${ACME_EMAIL:-admin@${DOMAIN}}"

log() { echo -e "\n\033[1;36m[deploy]\033[0m $*"; }

if [ "$(id -u)" != "0" ]; then
  echo "Please run as root (this is a fresh-VPS bootstrap)." >&2
  exit 1
fi

# --- 1. Docker ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || {
  echo "docker compose plugin missing; installing docker-compose-plugin"; \
  apt-get update -y && apt-get install -y docker-compose-plugin; }

# --- 2. Code -----------------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  log "Updating existing checkout in $APP_DIR"
  git -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH"
  git -C "$APP_DIR" checkout "$REPO_BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$REPO_BRANCH"
else
  log "Cloning repo to $APP_DIR"
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
fi

# --- 3. Detect public IP -----------------------------------------------------
PUBLIC_IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me || true)"
if [ -z "$PUBLIC_IP" ]; then
  echo "Could not auto-detect public IP. Set PUBLIC_IP=... and re-run." >&2
  exit 1
fi
log "Domain: $DOMAIN   Public IP: $PUBLIC_IP"

# --- 4. Secrets + .env (idempotent) -----------------------------------------
ENV_FILE="$APP_DIR/infra/.env"
if [ ! -f "$ENV_FILE" ]; then
  log "Generating secrets and writing $ENV_FILE"
  gen() { openssl rand -hex 32; }
  SEED_PW="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  cat > "$ENV_FILE" <<EOF
DOMAIN=${DOMAIN}
PUBLIC_IP=${PUBLIC_IP}
ACME_EMAIL=${ACME_EMAIL}

POSTGRES_USER=remote
POSTGRES_PASSWORD=$(gen)
POSTGRES_DB=remote_support

JWT_SECRET=$(gen)
JWT_TTL=3600s
AGENT_ENROLLMENT_TOKEN=$(gen)
# 30 minutes: generous enough for an end user to open the connect page,
# download, clear SmartScreen, and run before the one-time code expires.
SESSION_CODE_TTL=1800s
SESSION_CODE_LENGTH=9

SEED_TECH_EMAIL=admin@${DOMAIN}
SEED_TECH_PASSWORD=${SEED_PW}

TURN_REALM=${DOMAIN}
TURN_USER=turnuser
TURN_PASSWORD=$(gen)
EOF
  chmod 600 "$ENV_FILE"
else
  log "Reusing existing $ENV_FILE (keeping current secrets)"
  # Keep DOMAIN/PUBLIC_IP fresh in case the IP changed.
  sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" "$ENV_FILE"
  sed -i "s|^PUBLIC_IP=.*|PUBLIC_IP=${PUBLIC_IP}|" "$ENV_FILE"
  # Migrate the old too-short 5-minute code TTL to 30 minutes (leaves any
  # value the operator set themselves untouched).
  sed -i "s|^SESSION_CODE_TTL=300s\$|SESSION_CODE_TTL=1800s|" "$ENV_FILE"
fi

# --- 4b. Fetch the connect-page agent binary (best-effort) -------------------
# The connect page (connect.$DOMAIN) hands this exact binary to end users so it
# self-configures and joins on launch. It is a Windows build, produced by CI and
# attached to the GitHub release, so we fetch it rather than build it here.
AGENT_EXE_URL="${AGENT_EXE_URL:-https://github.com/sameerhameedbaba-stack/remote-Tool/releases/latest/download/remote-agent.exe}"
AGENT_DIST="$APP_DIR/infra/agent-dist"
mkdir -p "$AGENT_DIST"
log "Fetching connect-page agent binary from $AGENT_EXE_URL"
if curl -fL --retry 3 "$AGENT_EXE_URL" -o "$AGENT_DIST/remote-agent.exe.tmp" 2>/dev/null \
  && [ -s "$AGENT_DIST/remote-agent.exe.tmp" ]; then
  mv "$AGENT_DIST/remote-agent.exe.tmp" "$AGENT_DIST/remote-agent.exe"
  log "connect-page agent binary ready ($(du -h "$AGENT_DIST/remote-agent.exe" | cut -f1))"
else
  rm -f "$AGENT_DIST/remote-agent.exe.tmp"
  log "WARNING: could not fetch remote-agent.exe yet. The console + unattended"
  log "         installer still work; the connect.$DOMAIN one-click download will"
  log "         404 until a release publishes remote-agent.exe. Re-run this"
  log "         script (or set AGENT_EXE_URL) once the asset exists."
fi

# --- 5. Firewall (only if ufw is active; never lock out SSH) -----------------
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  log "Opening firewall ports via ufw"
  ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw allow 3478 >/dev/null 2>&1 || true
  ufw allow 49160:49200/udp >/dev/null 2>&1 || true
fi

# --- 6. Launch ---------------------------------------------------------------
log "Building and starting the stack (first run pulls + builds — a few minutes)..."
cd "$APP_DIR/infra"
docker compose -f docker-compose.prod.yml up -d --build

# --- 7. Report ---------------------------------------------------------------
SEED_EMAIL="$(grep '^SEED_TECH_EMAIL=' "$ENV_FILE" | cut -d= -f2-)"
SEED_PASS="$(grep '^SEED_TECH_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
ENROLL="$(grep '^AGENT_ENROLLMENT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"

cat <<EOF

========================================================================
  DEPLOYED. Give Caddy ~1 minute to obtain the HTTPS certificate.
========================================================================

  Console (log in here):   https://${DOMAIN}
    email:     ${SEED_EMAIL}
    password:  ${SEED_PASS}

  Easiest way to connect someone (no install, no typing):
    1. In the console, click "Create code" to get a 9-digit code.
    2. Send them:  https://connect.${DOMAIN}
    3. They enter the code, run the file it downloads — you get control.
    (Requires a DNS A record for connect.${DOMAIN} → this host, and a release
     that publishes remote-agent.exe. See docs/CONNECT.md.)

  Or, for a permanent unattended install, the Windows agent installer uses:
    Backend API URL:    https://${DOMAIN}
    WebSocket URL:      wss://${DOMAIN}
    Enrollment token:   ${ENROLL}

  Check health:
    curl https://${DOMAIN}/healthz     (expect: ok)
    curl https://${DOMAIN}/readyz      (expect: ok)

  Watch logs:
    cd ${APP_DIR}/infra && docker compose -f docker-compose.prod.yml logs -f

  KEEP these credentials safe — they are stored in ${ENV_FILE}.
========================================================================
EOF
