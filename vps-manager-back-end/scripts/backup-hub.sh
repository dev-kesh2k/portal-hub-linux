#!/usr/bin/env bash
# Backup diário do Hub: Postgres (Docker) + volumes críticos.
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/opt/hub-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${BACKUP_ROOT}/${STAMP}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-postgres}"
DATABASE_USER="${DATABASE_USER:-postgres}"
DATABASE_NAME="${DATABASE_NAME:-central_apps_hub}"

mkdir -p "$DEST"
echo "==> Backup Hub → $DEST"

if docker ps --format '{{.Names}}' | grep -qx "$POSTGRES_CONTAINER"; then
  echo "PostgreSQL dump (${DATABASE_NAME})..."
  docker exec "$POSTGRES_CONTAINER" pg_dump -U "$DATABASE_USER" -d "$DATABASE_NAME" --clean --if-exists \
    > "${DEST}/central_apps_hub.sql"
  # dump all DBs (apps no mesmo Postgres)
  docker exec "$POSTGRES_CONTAINER" pg_dumpall -U "$DATABASE_USER" --clean --if-exists \
    > "${DEST}/postgres-all.sql" || true
  gzip -f "${DEST}/central_apps_hub.sql" "${DEST}/postgres-all.sql" 2>/dev/null || true
else
  echo "AVISO: container ${POSTGRES_CONTAINER} não está rodando" >&2
fi

echo "Volumes Docker críticos..."
for vol in postgres_postgres_data portainer_data pgadmin_data; do
  if docker volume inspect "$vol" >/dev/null 2>&1; then
    docker run --rm \
      -v "${vol}:/from:ro" \
      -v "${DEST}:/to" \
      alpine sh -c "cd /from && tar czf /to/${vol}.tar.gz ." \
      && echo "  ok $vol" \
      || echo "  falhou $vol" >&2
  fi
done

# metadados
{
  echo "stamp=${STAMP}"
  echo "host=$(hostname)"
  date -Is
  docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null || true
} > "${DEST}/meta.txt"

echo "Limpando backups com mais de ${RETENTION_DAYS} dias..."
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+${RETENTION_DAYS}" -exec rm -rf {} + 2>/dev/null || true

echo "OK: $DEST"
du -sh "$DEST" 2>/dev/null || true
