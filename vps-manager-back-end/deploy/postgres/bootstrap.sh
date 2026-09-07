#!/bin/bash
set -euo pipefail
docker exec postgres psql -U postgres -c "SELECT datname FROM pg_database ORDER BY 1;"
docker exec postgres psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='central_apps_hub'" | grep -q 1 \
  || docker exec postgres psql -U postgres -c "CREATE DATABASE central_apps_hub;"
docker exec postgres psql -U postgres -c "SELECT datname FROM pg_database WHERE datname='central_apps_hub';"
echo "Windows probe skipped here"
