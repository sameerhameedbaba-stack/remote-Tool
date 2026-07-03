#!/usr/bin/env bash
# Provision throwaway Postgres + Redis for the test suites and export their URLs.
#
# Exports TEST_DATABASE_URL and TEST_REDIS_URL. Call `provision_up` to start and
# `provision_down` to stop. Uses local binaries (no Docker daemon required) so it
# runs in CI and in the web sandbox alike. Postgres must run as a non-root user;
# if the caller is root we drop to the `postgres` system user for the server.

set -euo pipefail

# Locate the Postgres server bindir (initdb/pg_ctl). Override with PG_BIN.
_detect_pg_bin() {
  if [ -n "${PG_BIN:-}" ] && [ -x "$PG_BIN/initdb" ]; then echo "$PG_BIN"; return; fi
  if command -v pg_config >/dev/null 2>&1; then
    local d; d="$(pg_config --bindir 2>/dev/null)"
    if [ -x "$d/initdb" ]; then echo "$d"; return; fi
  fi
  local cand
  for cand in /usr/lib/postgresql/*/bin /usr/pgsql-*/bin /opt/homebrew/opt/postgresql*/bin; do
    if [ -x "$cand/initdb" ]; then echo "$cand"; return; fi
  done
  echo "/usr/lib/postgresql/16/bin"
}
PG_BIN="$(_detect_pg_bin)"
PG_PORT="${PG_PORT:-55432}"
REDIS_PORT="${REDIS_PORT:-56379}"
PG_DATA="${PG_DATA:-/tmp/rs-test-pg}"
PG_LOG="${PG_LOG:-/tmp/rs-test-pg.log}"

export TEST_DATABASE_URL="postgres://remote@127.0.0.1:${PG_PORT}/remote_support?sslmode=disable"
export TEST_REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/0"

_pg_as() {
  # Run a command as the postgres user when we are root, else directly.
  if [ "$(id -u)" = "0" ]; then
    su postgres -c "$*"
  else
    bash -c "$*"
  fi
}

provision_up() {
  echo "[provision] starting postgres on :${PG_PORT} and redis on :${REDIS_PORT}"
  rm -rf "$PG_DATA" "$PG_LOG"
  mkdir -p "$PG_DATA"
  if [ "$(id -u)" = "0" ]; then
    chown postgres:postgres "$PG_DATA"
    chmod 700 "$PG_DATA"
  fi
  _pg_as "$PG_BIN/initdb -D $PG_DATA -U remote --auth=trust" >/dev/null 2>&1
  _pg_as "$PG_BIN/pg_ctl -D $PG_DATA -o '-p $PG_PORT -k /tmp -c listen_addresses=127.0.0.1' -l $PG_LOG start" >/dev/null 2>&1
  # Wait for readiness.
  for _ in $(seq 1 30); do
    if "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  _pg_as "$PG_BIN/createdb -p $PG_PORT -h /tmp -U remote remote_support" >/dev/null 2>&1 || true

  redis-server --port "$REDIS_PORT" --daemonize yes --save '' --appendonly no >/dev/null 2>&1
  for _ in $(seq 1 15); do
    if redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then break; fi
    sleep 1
  done
  echo "[provision] TEST_DATABASE_URL=$TEST_DATABASE_URL"
  echo "[provision] TEST_REDIS_URL=$TEST_REDIS_URL"
}

provision_down() {
  echo "[provision] stopping postgres + redis"
  _pg_as "$PG_BIN/pg_ctl -D $PG_DATA stop -m immediate" >/dev/null 2>&1 || true
  redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  rm -rf "$PG_DATA" "$PG_LOG" 2>/dev/null || true
}
