#!/usr/bin/env bash
set -euo pipefail

SLUG="${SLUG:-erasmo-chopp}"
WIN_FE="${WIN_FE:-/mnt/c/Users/Jefer/Documents/GitHub/Erasmo_chopp_frontend}"
WIN_BE="${WIN_BE:-/mnt/c/Users/Jefer/Documents/GitHub/Erasmo_chopp_backend}"
HUB_BE="${HUB_BE:-/mnt/c/Users/Jefer/Documents/GitHub/vps-manager-back-end}"
APACHE_DEST="/hub-apps/apache/${SLUG}"
SERVICOS_DEST="/hub-apps/servicos/${SLUG}"

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

echo "==> Frontend: build Hub (${SLUG})"
cd "$WIN_FE"
if [ ! -d node_modules ]; then npm install --ignore-scripts; fi
npm run build:hub

echo "==> Frontend: publicar em ${APACHE_DEST}"
docker run --rm -v "${APACHE_DEST}:/dest" -v "${WIN_FE}/dist:/src" alpine sh -c "
  find /dest -mindepth 1 -delete 2>/dev/null || true
  cp -a /src/. /dest/
  chmod -R a+rX /dest
"

echo "==> Hub: unificar app e rotas"
cd "$HUB_BE"
./node_modules/.bin/tsx scripts/hub-apps-repair.ts merge

echo "==> Backend: sincronizar código"
mkdir -p "$SERVICOS_DEST"
docker run --rm \
  -v "${WIN_BE}:/src:ro" \
  -v "${SERVICOS_DEST}:/dest" \
  alpine sh -c '
    apk add --no-cache rsync >/dev/null
    rsync -a --delete \
      --exclude node_modules \
      --exclude dist \
      --exclude .git \
      --exclude uploads \
      --exclude docker-compose.hub.yml \
      --exclude .env \
      --exclude "*.log" \
      /src/ /dest/
    chmod -R a+rX /dest
  '

if [ -f "$SERVICOS_DEST/docker-compose.hub.yml" ]; then
  echo "==> Backend: rebuild containers"
  cd "$SERVICOS_DEST"
  docker run --rm -e TARGET="$SLUG" -v "$SERVICOS_DEST:/app" alpine sh -c '
    if [ -f /app/.env ] && grep -q "^PUBLIC_PATH=" /app/.env; then
      sed -i "s|^PUBLIC_PATH=.*|PUBLIC_PATH=/$TARGET|" /app/.env
    fi
    if [ -f /app/docker-compose.hub.yml ]; then
      sed -i "s|PUBLIC_PATH: /[^[:space:]]*|PUBLIC_PATH: /$TARGET|g" /app/docker-compose.hub.yml
    fi
  '
  if docker compose version >/dev/null 2>&1; then
    docker compose -f docker-compose.hub.yml up -d --build
  else
    docker-compose -f docker-compose.hub.yml up -d --build
  fi
fi

echo "==> Hub: sincronizar Apache"
cd "$HUB_BE"
./node_modules/.bin/tsx scripts/hub-apps-repair.ts repair

echo "==> Verificação"
curl -sf --max-time 5 "http://127.0.0.1:8081/${SLUG}/" >/dev/null
curl -sf --max-time 5 "http://127.0.0.1:8081/${SLUG}/api/health" >/dev/null
curl -sf --max-time 5 "http://127.0.0.1:8081/${SLUG}/admin" >/dev/null
echo "OK: https://central-apps-hub.com.br/${SLUG}/"
