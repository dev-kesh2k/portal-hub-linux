#!/bin/bash
set -euo pipefail
echo "=== docker networks ==="
docker inspect postgres --format '{{json .NetworkSettings}}'
echo
echo "=== wsl listeners 5432/5433 ==="
ss -lntp | grep -E '5432|5433' || true
echo "=== container ip ==="
docker exec postgres hostname -i || true
echo "=== auth inside container ==="
docker exec postgres psql -U postgres -d central_apps_hub -c "SELECT current_user, current_database();"
