#!/usr/bin/env bash
# End-to-end test: real backend (+ Postgres + Redis) + the real Rust agent
# running in `service` mode on Linux + a headless-browser technician peer.
#
# Proves the full platform path minus the Windows-only screen capture / input
# injection (documented stubs): enrollment, presence, session start, mandatory
# banner ack, WebRTC signaling, a live peer connection with data channels, and
# the audit trail for file.transfer / clipboard.sync / input.command_attempt.
#
# Runs entirely on local binaries (no Docker daemon needed). Single invocation:
#   bash test/run-e2e.sh

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=test/lib/provision.sh
source test/lib/provision.sh
# provision.sh enables `set -e`; we do our own error handling below.
set +e

BACKEND_PORT=18080
PAGE_PORT=3999
BACKEND_BIN=/tmp/rs-e2e-backend
AGENT_BIN=/tmp/rs-e2e-agent
AGENT_TOKEN=/tmp/rs-e2e-agent-token
AGENT_DL=/tmp/rs-e2e-downloads
BACKEND_LOG=/tmp/rs-e2e-backend.log
AGENT_LOG=/tmp/rs-e2e-agent.log
ENROLL_TOKEN=e2e-enrollment-token

BACKEND_PID=""
AGENT_PID=""

cleanup() {
  echo "[e2e] cleanup"
  [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null
  sleep 1
  [ -n "$AGENT_PID" ] && kill -9 "$AGENT_PID" 2>/dev/null
  [ -n "$BACKEND_PID" ] && kill -9 "$BACKEND_PID" 2>/dev/null
  provision_down
  rm -f "$BACKEND_BIN" "$AGENT_BIN" "$AGENT_TOKEN" "$BACKEND_LOG" "$AGENT_LOG" 2>/dev/null
  rm -rf "$AGENT_DL" 2>/dev/null
}
trap cleanup EXIT

fail() { echo "E2E FAIL: $1"; exit 1; }

provision_up

echo "[e2e] building backend + agent"
( cd backend-go && GOTOOLCHAIN=local go build -o "$BACKEND_BIN" ./cmd/server ) || fail "backend build"
( cd agent-rust && cargo build --quiet ) || fail "agent build"
cp agent-rust/target/debug/remote-agent "$AGENT_BIN" || fail "agent binary copy"

echo "[e2e] starting backend on :$BACKEND_PORT"
APP_ENV=dev \
BACKEND_HTTP_ADDR=":$BACKEND_PORT" \
DATABASE_URL="$TEST_DATABASE_URL" \
REDIS_URL="$TEST_REDIS_URL" \
JWT_SECRET="e2e-jwt-secret-value-at-least-32-bytes-long!!" \
JWT_TTL=3600s \
AGENT_ENROLLMENT_TOKEN="$ENROLL_TOKEN" \
SESSION_CODE_TTL=300s SESSION_CODE_LENGTH=9 \
CORS_ALLOWED_ORIGIN="http://127.0.0.1:$PAGE_PORT" \
SEED_TECH_EMAIL="admin@example.com" SEED_TECH_PASSWORD="devadminpassword" \
ICE_SERVERS='[]' \
TURN_USER=turnuser TURN_PASSWORD=turnpass TURN_REALM=e2e.local \
"$BACKEND_BIN" >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

# Wait for the backend to be ready.
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$BACKEND_PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -sf "http://127.0.0.1:$BACKEND_PORT/healthz" >/dev/null 2>&1 || { cat "$BACKEND_LOG"; fail "backend did not become ready"; }
echo "[e2e] backend ready"

echo "[e2e] enrolling agent"
rm -f "$AGENT_TOKEN"; mkdir -p "$AGENT_DL"
REMOTE_AGENT_API_BASE="http://127.0.0.1:$BACKEND_PORT" \
REMOTE_AGENT_WS_BASE="ws://127.0.0.1:$BACKEND_PORT" \
REMOTE_AGENT_ENROLLMENT_TOKEN="$ENROLL_TOKEN" \
REMOTE_AGENT_TOKEN_PATH="$AGENT_TOKEN" \
REMOTE_AGENT_DOWNLOADS_DIR="$AGENT_DL" \
"$AGENT_BIN" enroll --name E2E-AGENT >"$AGENT_LOG" 2>&1 || { cat "$AGENT_LOG"; fail "agent enroll"; }

# The non-Windows token file is plaintext "device_id.secret".
DEVICE_ID="$(cut -d. -f1 < "$AGENT_TOKEN")"
[ -n "$DEVICE_ID" ] || fail "could not determine device id"
echo "[e2e] agent enrolled: device_id=$DEVICE_ID"

echo "[e2e] starting agent service"
REMOTE_AGENT_API_BASE="http://127.0.0.1:$BACKEND_PORT" \
REMOTE_AGENT_WS_BASE="ws://127.0.0.1:$BACKEND_PORT" \
REMOTE_AGENT_TOKEN_PATH="$AGENT_TOKEN" \
REMOTE_AGENT_DOWNLOADS_DIR="$AGENT_DL" \
RUST_LOG=info \
"$AGENT_BIN" service >>"$AGENT_LOG" 2>&1 &
AGENT_PID=$!

echo "[e2e] running browser driver"
E2E_BASE="http://127.0.0.1:$BACKEND_PORT" \
E2E_WS_BASE="ws://127.0.0.1:$BACKEND_PORT" \
E2E_DEVICE_ID="$DEVICE_ID" \
E2E_TECH_EMAIL="admin@example.com" E2E_TECH_PASSWORD="devadminpassword" \
E2E_PAGE_PORT="$PAGE_PORT" \
node test/e2e/run.mjs
RC=$?

if [ $RC -ne 0 ]; then
  echo "----- agent log (tail) -----"; tail -30 "$AGENT_LOG"
  echo "----- backend log (tail) -----"; tail -20 "$BACKEND_LOG"
  fail "browser driver exited $RC"
fi
echo "[e2e] SUCCESS"
