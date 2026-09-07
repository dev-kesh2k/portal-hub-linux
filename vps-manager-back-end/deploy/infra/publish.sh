#!/usr/bin/env bash
set -euo pipefail

# No Git Bash / Windows, o Hub vive no WSL (/opt, /hub-apps, Docker).
# Reexecuta automaticamente dentro do WSL quando necessário.
if [[ "${OS:-}" == "Windows_NT" || "$(uname -s 2>/dev/null)" == MINGW* || "$(uname -s 2>/dev/null)" == MSYS* || "$(uname -s 2>/dev/null)" == CYGWIN* ]]; then
  if ! command -v wsl >/dev/null 2>&1; then
    echo "Este script precisa rodar no WSL (Docker/Linux do Hub)." >&2
    echo "Instale o WSL ou abra um terminal WSL e rode:" >&2
    echo "  bash deploy/infra/publish.sh" >&2
    exit 1
  fi
  SCRIPT_WIN="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)/$(basename "$0")"
  SCRIPT_WIN="${SCRIPT_WIN//\\//}"
  DRIVE="$(echo "${SCRIPT_WIN:0:1}" | tr '[:upper:]' '[:lower:]')"
  SCRIPT_WSL="/mnt/${DRIVE}${SCRIPT_WIN:2}"
  echo "Detectado Windows/Git Bash → executando no WSL..."
  exec wsl -e bash "$SCRIPT_WSL" "$@"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APACHE_SRC="${ROOT}/apache"
PG_SRC="${ROOT}/postgres"

if [[ -z "${WINHOST:-}" || "${WINHOST}" == "host-gateway" ]]; then
  WINHOST="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4; exit}' | cut -d/ -f1 || true)"
fi
if [[ -z "${WINHOST:-}" ]]; then
  WINHOST="$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}' || true)"
fi
WINHOST="${WINHOST:-host-gateway}"
export WINHOST

echo "=== Hub infra (Apache + PostgreSQL) ==="
echo "WINHOST=${WINHOST}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker não encontrado neste ambiente. Rode dentro do WSL onde o Hub está instalado." >&2
  exit 1
fi

mkdir -p /opt/apache /opt/postgres /hub-apps/apache

cp "${APACHE_SRC}/docker-compose.yml" /opt/apache/docker-compose.yml
# Não sobrescrever hub.conf existente: o backend injeta rotas dinâmicas
# (Portainer, apps, etc.). Só publica o template se ainda não houver arquivo.
if [[ ! -f /opt/apache/hub.conf && -f "${APACHE_SRC}/hub.conf" ]]; then
  cp "${APACHE_SRC}/hub.conf" /opt/apache/hub.conf
elif [[ -f "${APACHE_SRC}/hub.conf" ]]; then
  echo "hub.conf preservado (rotas dinâmicas mantidas)"
fi
if [[ -f "${APACHE_SRC}/redeploy.sh" ]]; then
  cp "${APACHE_SRC}/redeploy.sh" /opt/apache/redeploy.sh
  chmod +x /opt/apache/redeploy.sh
fi

cp "${PG_SRC}/docker-compose.yml" /opt/postgres/docker-compose.yml

echo "--- postgres ---"
(cd /opt/postgres && docker compose up -d --remove-orphans)
echo "--- apache ---"
# Remove container legado se existir sob outro project name do Compose
if docker inspect apache >/dev/null 2>&1; then
  docker rm -f apache >/dev/null 2>&1 || true
fi
(cd /opt/apache && docker compose up -d --remove-orphans --force-recreate)

sleep 2
docker ps --filter name=postgres --filter name=apache --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo "OK: infra publicada"
