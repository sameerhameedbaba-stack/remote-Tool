#!/usr/bin/env bash
# Nightly Postgres backup for the Remote Support platform.
#
# Dumps the database from the running postgres container to a timestamped,
# gzipped file and prunes backups older than RETENTION_DAYS. Safe to run from
# cron. It never prints secrets.
#
# Install (on the VPS, as root):
#   chmod +x /opt/remote-tool/infra/backup.sh
#   # add to crontab: nightly at 02:30
#   (crontab -l 2>/dev/null; echo "30 2 * * * /opt/remote-tool/infra/backup.sh >> /var/log/remote-backup.log 2>&1") | crontab -
#
# Restore (DESTRUCTIVE — overwrites the current DB):
#   gunzip -c /opt/remote-tool/backups/remote_support-YYYYmmdd-HHMMSS.sql.gz \
#     | docker exec -i $(docker compose -f /opt/remote-tool/infra/docker-compose.prod.yml ps -q postgres) \
#         psql -U remote -d remote_support

set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="docker compose -f ${INFRA_DIR}/docker-compose.prod.yml"
BACKUP_DIR="${BACKUP_DIR:-${INFRA_DIR}/../backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PG_USER="${POSTGRES_USER:-remote}"
PG_DB="${POSTGRES_DB:-remote_support}"

mkdir -p "$BACKUP_DIR"

# Resolve the postgres container id via compose so this works regardless of the
# project/container naming.
PG_CID="$($COMPOSE ps -q postgres)"
if [ -z "$PG_CID" ]; then
  echo "[backup] postgres container not running — aborting" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/${PG_DB}-${STAMP}.sql.gz"

echo "[backup] dumping ${PG_DB} -> ${OUT}"
# pg_dump inside the container; gzip on the host. --clean makes the dump
# restorable onto an existing database.
docker exec "$PG_CID" pg_dump -U "$PG_USER" --clean --if-exists "$PG_DB" | gzip -c > "$OUT"

# Fail loudly if the dump is suspiciously small (e.g. auth failure produced an
# empty file).
if [ "$(stat -c%s "$OUT")" -lt 1024 ]; then
  echo "[backup] dump is under 1KB — likely failed, removing ${OUT}" >&2
  rm -f "$OUT"
  exit 1
fi

echo "[backup] ok ($(du -h "$OUT" | cut -f1)); pruning backups older than ${RETENTION_DAYS}d"
find "$BACKUP_DIR" -name "${PG_DB}-*.sql.gz" -type f -mtime "+${RETENTION_DAYS}" -print -delete
echo "[backup] done"
