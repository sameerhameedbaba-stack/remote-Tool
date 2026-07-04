#!/usr/bin/env bash
# Smoke test: build and boot the real backend against a throwaway Postgres+Redis,
# then verify it is alive and correctly wired. Fast (~a few seconds after build),
# no browser, no agent. Answers "is the service fundamentally up?".
#
#   bash test/smoke.sh
#
# Checks: /healthz 200, /readyz 200 (real DB+Redis ping), a protected route
# rejects an anonymous request (401), and the binary's own `-healthcheck`
# self-probe (used by the Docker HEALTHCHECK) returns success.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=test/lib/provision.sh
source test/lib/provision.sh
set +e   # provision.sh enables set -e; do our own error handling

PORT=18085
BIN=/tmp/rs-smoke-backend
LOG=/tmp/rs-smoke-backend.log
PID=""

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
  sleep 1
  [ -n "$PID" ] && kill -9 "$PID" 2>/dev/null
  provision_down
  rm -f "$BIN" "$LOG" 2>/dev/null
}
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $1"; [ -f "$LOG" ] && tail -20 "$LOG"; exit 1; }
ok()   { echo "  ok  $1"; }

provision_up

echo "[smoke] building backend"
( cd backend-go && GOTOOLCHAIN=local go build -o "$BIN" ./cmd/server ) || fail "backend build"

echo "[smoke] starting backend on :$PORT"
export APP_ENV=dev BACKEND_HTTP_ADDR=":$PORT" \
  DATABASE_URL="$TEST_DATABASE_URL" REDIS_URL="$TEST_REDIS_URL" \
  JWT_SECRET="smoke-jwt-secret-value-at-least-32-bytes!!" JWT_TTL=3600s \
  AGENT_ENROLLMENT_TOKEN="smoke-enroll-token" \
  SESSION_CODE_TTL=300s SESSION_CODE_LENGTH=9 \
  CORS_ALLOWED_ORIGIN="http://127.0.0.1:3000" \
  ICE_SERVERS='[]' TURN_USER=u TURN_PASSWORD=p TURN_REALM=smoke.local
"$BIN" >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done

# 1. Liveness
curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 || fail "/healthz not 200"
ok "/healthz → 200"

# 2. Readiness (pings DB + Redis)
curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1 || fail "/readyz not 200 (DB/Redis wiring)"
ok "/readyz → 200 (DB + Redis reachable)"

# 3. A protected route rejects anonymous access
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/v1/me")
[ "$code" = "401" ] || fail "GET /api/v1/me anonymous: want 401, got $code"
ok "protected route rejects anonymous → 401"

# 4. The binary's own healthcheck self-probe (Docker HEALTHCHECK path)
BACKEND_HTTP_ADDR=":$PORT" "$BIN" -healthcheck || fail "binary -healthcheck self-probe failed"
ok "binary -healthcheck self-probe → 0"

echo "SMOKE PASS: backend boots, is ready, enforces auth, and self-probes."
