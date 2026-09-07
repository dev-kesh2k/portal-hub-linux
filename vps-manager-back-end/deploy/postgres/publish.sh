#!/bin/bash
set -euo pipefail

COMPOSE=/opt/postgres/docker-compose.yml
SRC="$(cd "$(dirname "$0")" && pwd)/docker-compose.yml"

mkdir -p /opt/postgres
cp "$SRC" "$COMPOSE"

echo "----- compose -----"
cat "$COMPOSE"

cd /opt/postgres
docker compose up -d --force-recreate
sleep 2
docker ps --filter name=postgres --format '{{.Names}} {{.Status}} {{.Ports}}'
docker exec postgres psql -U postgres -d postgres -c "SELECT current_database();" || true
# Hub database (created by backend init if missing)
docker exec postgres psql -U postgres -d postgres -c "SELECT 1 FROM pg_database WHERE datname='central_apps_hub'" | grep -q 1 \
  && docker exec postgres psql -U postgres -d central_apps_hub -c "SELECT current_database();" \
  || echo "DB central_apps_hub ainda não existe (ok — o backend cria no startup)"
