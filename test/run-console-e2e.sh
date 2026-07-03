#!/usr/bin/env bash
# Console UI end-to-end test: real backend + the real Next.js console + a headless
# browser driving the operator flows (login, attended code, devices, audit,
# session banner). Runs on local binaries; single invocation:
#   bash test/run-console-e2e.sh

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=test/lib/provision.sh
source test/lib/provision.sh
set +e   # provision.sh enables `set -e`; we handle errors ourselves.

BACKEND_PORT=8080
CONSOLE_PORT=3000
BACKEND_BIN=/tmp/rs-ce2e-backend
BACKEND_LOG=/tmp/rs-ce2e-backend.log
CONSOLE_LOG=/tmp/rs-ce2e-console.log
ENROLL_TOKEN=console-e2e-enroll-token
BACKEND_PID=""
CONSOLE_PID=""
HB_PID=""

cleanup() {
  echo "[console-e2e] cleanup"
  [ -n "$HB_PID" ] && kill "$HB_PID" 2>/dev/null
  [ -n "$CONSOLE_PID" ] && kill "$CONSOLE_PID" 2>/dev/null
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null
  sleep 1
  [ -n "$CONSOLE_PID" ] && kill -9 "$CONSOLE_PID" 2>/dev/null
  [ -n "$BACKEND_PID" ] && kill -9 "$BACKEND_PID" 2>/dev/null
  pkill -9 -f 'next-server|next start' 2>/dev/null
  provision_down
  rm -f "$BACKEND_BIN" "$BACKEND_LOG" "$CONSOLE_LOG" 2>/dev/null
}
trap cleanup EXIT
fail() { echo "CONSOLE E2E FAIL: $1"; exit 1; }

provision_up

echo "[console-e2e] building + starting backend on :$BACKEND_PORT"
( cd backend-go && GOTOOLCHAIN=local go build -o "$BACKEND_BIN" ./cmd/server ) || fail "backend build"
APP_ENV=dev BACKEND_HTTP_ADDR=":$BACKEND_PORT" \
DATABASE_URL="$TEST_DATABASE_URL" REDIS_URL="$TEST_REDIS_URL" \
JWT_SECRET="console-e2e-jwt-secret-at-least-32-bytes-long!!" JWT_TTL=3600s \
AGENT_ENROLLMENT_TOKEN="$ENROLL_TOKEN" \
SESSION_CODE_TTL=300s SESSION_CODE_LENGTH=9 \
CORS_ALLOWED_ORIGIN="http://localhost:$CONSOLE_PORT" \
SEED_TECH_EMAIL="admin@example.com" SEED_TECH_PASSWORD="devadminpassword" \
ICE_SERVERS='["stun:coturn:3478"]' TURN_USER=t TURN_PASSWORD=p TURN_REALM=e2e \
"$BACKEND_BIN" >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$BACKEND_PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$BACKEND_PORT/healthz" >/dev/null 2>&1 || { cat "$BACKEND_LOG"; fail "backend not ready"; }

echo "[console-e2e] seeding an online device + a session"
JWT=$(curl -s -X POST "http://127.0.0.1:$BACKEND_PORT/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"devadminpassword"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$JWT" ] || fail "seed login"
DEV_NAME="CONSOLE-DEV"
ENROLL=$(curl -s -X POST "http://127.0.0.1:$BACKEND_PORT/api/v1/agent/enroll" -H 'Content-Type: application/json' \
  -d "{\"enrollment_token\":\"$ENROLL_TOKEN\",\"name\":\"$DEV_NAME\",\"hostname\":\"console-dev\",\"os\":\"windows\"}")
DEVTOK=$(echo "$ENROLL" | sed -n 's/.*"device_token":"\([^"]*\)".*/\1/p')
DEVID=$(echo "$ENROLL" | sed -n 's/.*"device_id":"\([^"]*\)".*/\1/p')
[ -n "$DEVTOK" ] || fail "enroll seed device"
curl -s -X POST "http://127.0.0.1:$BACKEND_PORT/api/v1/agent/heartbeat" -H "Authorization: Bearer $DEVTOK" \
  -H 'Content-Type: application/json' -d '{"status":"idle"}' >/dev/null
SID=$(curl -s -X POST "http://127.0.0.1:$BACKEND_PORT/api/v1/sessions" -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d "{\"device_id\":\"$DEVID\"}" | sed -n 's/.*"session":{"id":"\([^"]*\)".*/\1/p')
[ -n "$SID" ] || fail "create seed session"
echo "[console-e2e] seeded device=$DEVID session=$SID"

# Keep the device online for the whole run (presence TTL is 30s; the console
# build + browser steps take longer than that).
( while true; do
    curl -s -X POST "http://127.0.0.1:$BACKEND_PORT/api/v1/agent/heartbeat" \
      -H "Authorization: Bearer $DEVTOK" -H 'Content-Type: application/json' \
      -d '{"status":"idle"}' >/dev/null 2>&1
    sleep 10
  done ) &
HB_PID=$!

echo "[console-e2e] building + starting console on :$CONSOLE_PORT"
( cd web-console && NEXT_PUBLIC_API_BASE_URL="http://localhost:$BACKEND_PORT" \
  NEXT_PUBLIC_WS_BASE_URL="ws://localhost:$BACKEND_PORT" npm run build ) >"$CONSOLE_LOG" 2>&1 || { tail -20 "$CONSOLE_LOG"; fail "console build"; }
( cd web-console && NEXT_PUBLIC_API_BASE_URL="http://localhost:$BACKEND_PORT" \
  NEXT_PUBLIC_WS_BASE_URL="ws://localhost:$BACKEND_PORT" npm run start -- -p "$CONSOLE_PORT" ) >>"$CONSOLE_LOG" 2>&1 &
CONSOLE_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$CONSOLE_PORT/login" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$CONSOLE_PORT/login" >/dev/null 2>&1 || { tail -20 "$CONSOLE_LOG"; fail "console not ready"; }

echo "[console-e2e] running browser driver"
E2E_CONSOLE_URL="http://localhost:$CONSOLE_PORT" \
E2E_TECH_EMAIL="admin@example.com" E2E_TECH_PASSWORD="devadminpassword" \
E2E_DEVICE_NAME="$DEV_NAME" E2E_SESSION_ID="$SID" \
E2E_SHOTS_DIR="${E2E_SHOTS_DIR:-}" \
node test/e2e/console-e2e.mjs
RC=$?
[ $RC -eq 0 ] || fail "browser driver exited $RC"
echo "[console-e2e] SUCCESS"
