#!/usr/bin/env bash
# One-command test runner for the Remote Support MVP.
#
# Runs every automated suite and prints a summary:
#   1. Rust agent unit tests            (cargo test)
#   2. Go backend unit tests            (go test ./...)
#   3. Go backend integration tests     (real Postgres + Redis, -tags=integration)
#   4. Web console production build      (npm run build)
#   5. End-to-end WebRTC test            (backend + real agent + browser peer)
#   6. Console UI E2E                    (backend + console + browser)
#
# Everything runs on local binaries — no Docker daemon required. What is NOT
# covered here requires a Windows host: real screen capture, OS input injection,
# the native banner window, and DPAPI token storage (all documented stubs).
#
#   bash test/run-all.sh            # run everything
#   bash test/run-all.sh --quick    # skip the two browser E2E suites

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

RESULTS=()
FAILED=0
run() {
  local name="$1"; shift
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "▶ $name"
  echo "════════════════════════════════════════════════════════════"
  if "$@"; then
    RESULTS+=("PASS  $name")
  else
    RESULTS+=("FAIL  $name")
    FAILED=1
  fi
}

agent_unit() { ( cd agent-rust && cargo test --quiet ); }
backend_unit() { ( cd backend-go && GOTOOLCHAIN=local go test ./... ); }
console_build() { ( cd web-console && npm run build >/dev/null 2>&1 ); }

backend_integration() {
  # shellcheck source=test/lib/provision.sh
  source test/lib/provision.sh
  set +e
  provision_up
  ( cd backend-go && GOTOOLCHAIN=local go test -tags=integration ./internal/integration/... )
  local rc=$?
  provision_down
  return $rc
}

run "Rust agent unit tests"        agent_unit
run "Go backend unit tests"        backend_unit
run "Web console production build"  console_build
run "Go backend integration tests"  backend_integration
if [ "$QUICK" -eq 0 ]; then
  run "End-to-end WebRTC test"       bash test/run-e2e.sh
  run "Console UI E2E"               bash test/run-console-e2e.sh
else
  echo "[run-all] --quick: skipping browser E2E suites"
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo " SUMMARY"
echo "════════════════════════════════════════════════════════════"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "ALL SUITES PASSED"
else
  echo "SOME SUITES FAILED"
fi
exit $FAILED
