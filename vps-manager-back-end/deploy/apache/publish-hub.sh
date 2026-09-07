#!/bin/bash
set -euo pipefail

PROJECT="${PROJECT:-central-apps-hub}"
WIN_FRONT="/mnt/c/Users/Jefer/Documents/GitHub/vps-manager-front-end/dist"
WIN_BACK="/mnt/c/Users/Jefer/Documents/GitHub/vps-manager-back-end"
APACHE_ROOT="/hub-apps/apache"
SERVICOS_ROOT="/hub-apps/servicos"
APP_FRONT="${APACHE_ROOT}/${PROJECT}"
APP_BACK="${SERVICOS_ROOT}/${PROJECT}"

echo "Organizando ${PROJECT} em pastas por projeto..."

mkdir -p "${APP_FRONT}" "${APP_BACK}"

# Tira o app da raiz do Apache (assets, index.html, vite.svg).
if [ -f "${APACHE_ROOT}/index.html" ]; then
  rm -f "${APACHE_ROOT}/index.html" "${APACHE_ROOT}/vite.svg"
  rm -rf "${APACHE_ROOT}/assets"
fi

rm -rf "${APP_FRONT:?}/"*
cp -a "${WIN_FRONT}/." "${APP_FRONT}/"

# Move leftovers da raiz de servicos para a pasta do projeto (exceto outras pastas de projeto).
shopt -s nullglob
for item in "${SERVICOS_ROOT}"/*; do
  name="$(basename "${item}")"
  if [ "${name}" = "${PROJECT}" ]; then
    continue
  fi
  # Pastas que já são outros projetos (têm package.json ou index) ficam.
  if [ -d "${item}" ] && { [ -f "${item}/package.json" ] || [ -f "${item}/index.html" ]; }; then
    continue
  fi
  echo "Movendo ${item} -> ${APP_BACK}/"
  mv "${item}" "${APP_BACK}/"
done
shopt -u nullglob

# Sincroniza o backend do repositório para a pasta do projeto.
rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude data \
  --exclude '*.log' \
  "${WIN_BACK}/" "${APP_BACK}/"

cp "${WIN_BACK}/deploy/apache/hub.conf" /opt/apache/hub.conf
cp "${WIN_BACK}/deploy/apache/docker-compose.yml" /opt/apache/docker-compose.yml
cp "${WIN_BACK}/deploy/apache/redeploy.sh" /opt/apache/redeploy.sh
chmod +x /opt/apache/redeploy.sh

echo "Apache: ${APP_FRONT}"
echo "Servicos: ${APP_BACK}"
ls -la "${APACHE_ROOT}"
ls -la "${SERVICOS_ROOT}"

/opt/apache/redeploy.sh
