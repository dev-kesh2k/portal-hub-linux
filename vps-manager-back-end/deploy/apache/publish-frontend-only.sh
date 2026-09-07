#!/bin/bash
set -euo pipefail
SRC="/mnt/c/Users/Jefer/Documents/GitHub/vps-manager-front-end/dist"
DEST="/hub-apps/apache/central-apps-hub"
TMP="/tmp/hub-front-dist"

if [ ! -f "${SRC}/index.html" ]; then
  echo "dist/index.html não encontrado"
  exit 1
fi

rm -rf "${TMP}"
mkdir -p "${TMP}"
cp -a "${SRC}/." "${TMP}/"

mkdir -p "${DEST}"
rm -rf "${DEST:?}/"* 2>/dev/null || true
docker exec apache sh -c 'rm -rf /usr/local/apache2/htdocs/central-apps-hub/*'
docker cp "${TMP}/." apache:/usr/local/apache2/htdocs/central-apps-hub/
docker exec apache chmod -R a+rX /usr/local/apache2/htdocs/central-apps-hub
docker exec apache httpd -k graceful

echo "--- published ---"
ls -la "${DEST}"
echo "--- http ---"
curl -s -o /dev/null -w "local=%{http_code}\n" "http://127.0.0.1:8081/central-apps-hub/"
curl -s "http://127.0.0.1:8081/central-apps-hub/" | grep -E 'script type|index-'
