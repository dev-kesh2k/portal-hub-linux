#!/usr/bin/env bash
# Central Apps Hub — instalador appliance (Ubuntu 22.04 / 24.04)
# Uso (como root):
#   sudo bash deploy/appliance/install.sh \
#     --backend /caminho/vps-manager-back-end \
#     --frontend /caminho/vps-manager-front-end
set -euo pipefail

APP_NAME="central-apps-hub"
OPT_ROOT="/opt/${APP_NAME}"
BACKEND_DST="${OPT_ROOT}/backend"
FRONTEND_DST="${OPT_ROOT}/frontend"
HUB_USER="${HUB_USER:-hub}"
HUB_PORT="${HUB_PORT:-3001}"
SKIP_DOCKER=0
BACKEND_SRC=""
FRONTEND_SRC=""
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-http://127.0.0.1:8081}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_BACKEND="$(cd "${SCRIPT_DIR}/../.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend) BACKEND_SRC="$2"; shift 2 ;;
    --frontend) FRONTEND_SRC="$2"; shift 2 ;;
    --user) HUB_USER="$2"; shift 2 ;;
    --origin) PUBLIC_ORIGIN="$2"; shift 2 ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *) echo "Arg desconhecido: $1" >&2; exit 1 ;;
  esac
done

BACKEND_SRC="${BACKEND_SRC:-$REPO_BACKEND}"
if [[ -z "$FRONTEND_SRC" ]]; then
  if [[ -d "${BACKEND_SRC}/../vps-manager-front-end" ]]; then
    FRONTEND_SRC="$(cd "${BACKEND_SRC}/../vps-manager-front-end" && pwd)"
  fi
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Execute com sudo: sudo bash $0 ..." >&2
  exit 1
fi

if [[ ! -f "${BACKEND_SRC}/package.json" ]]; then
  echo "Backend nao encontrado em: $BACKEND_SRC" >&2
  exit 1
fi
if [[ -z "$FRONTEND_SRC" || ! -f "${FRONTEND_SRC}/package.json" ]]; then
  echo "Frontend nao encontrado. Passe --frontend /caminho/vps-manager-front-end" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Pacotes base"
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release rsync unzip tar python3 build-essential

if [[ "$SKIP_DOCKER" -eq 0 ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "==> Instalando Docker"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    . /etc/os-release
    DOCKER_CODENAME="${VERSION_CODENAME:-noble}"
    # Codigos muito novos (ex.: resolute) podem nao ter repo Docker ainda
    if ! curl -fsI "https://download.docker.com/linux/ubuntu/dists/${DOCKER_CODENAME}/Release" >/dev/null 2>&1; then
      DOCKER_CODENAME="noble"
      echo "Docker repo: usando fallback ${DOCKER_CODENAME}"
    fi
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${DOCKER_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    systemctl enable --now docker
  fi
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | tr -d v | cut -d. -f1)" -lt 20 ]]; then
  echo "==> Instalando Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Usuario ${HUB_USER}"
if ! id "$HUB_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/${HUB_USER}" --shell /bin/bash "$HUB_USER"
fi
usermod -aG docker "$HUB_USER" 2>/dev/null || true

echo "==> Diretorios"
mkdir -p "$BACKEND_DST" "$FRONTEND_DST" /hub-apps/apache /hub-apps/servicos /opt/apache /opt/postgres /var/log/central-apps-hub
chown -R "${HUB_USER}:${HUB_USER}" /hub-apps /opt/apache /opt/postgres /var/log/central-apps-hub
# hub precisa escrever confs e compose
chown -R "${HUB_USER}:${HUB_USER}" "$OPT_ROOT" 2>/dev/null || true

echo "==> Copiando codigo"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git --exclude backend.log --exclude backend.pid \
  --exclude .env --exclude 'dist-upload' \
  "${BACKEND_SRC}/" "${BACKEND_DST}/"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git \
  "${FRONTEND_SRC}/" "${FRONTEND_DST}/"
chown -R "${HUB_USER}:${HUB_USER}" "$OPT_ROOT"

echo "==> .env appliance"
ENV_FILE="${BACKEND_DST}/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  AUTH_USER="${AUTH_USERNAME:-admin}"
  AUTH_PASS="$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)"
  DB_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"
  DOCKER0="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4; exit}' | cut -d/ -f1 || true)"
  DOCKER0="${DOCKER0:-172.17.0.1}"
  cat > "$ENV_FILE" <<EOF
HUB_RUNTIME=appliance
PORT=${HUB_PORT}
PUBLIC_ORIGIN=${PUBLIC_ORIGIN}
CORS_ORIGIN=${PUBLIC_ORIGIN},http://127.0.0.1:8081,http://localhost:8081
AUTH_USERNAME=${AUTH_USER}
AUTH_PASSWORD=${AUTH_PASS}
DATABASE_HOST=127.0.0.1
DATABASE_PORT=5433
DATABASE_USER=postgres
DATABASE_PASSWORD=${DB_PASS}
DATABASE_NAME=central_apps_hub
DATABASE_POOL_MAX=4
APACHE_BACKEND_HOST=${DOCKER0}
HUB_APP_DB_HOST=${DOCKER0}
CF_ORIGIN_SERVICE=http://127.0.0.1:8081
NODE_OPTIONS=--max-old-space-size=384
# Preencha para publicar na internet via Cloudflare Tunnel:
# CF_API_TOKEN=
# CF_ACCOUNT_ID=
# CF_TUNNEL_ID=
# CF_TUNNEL_TOKEN=
EOF
  chmod 600 "$ENV_FILE"
  chown "${HUB_USER}:${HUB_USER}" "$ENV_FILE"
  cat > "${OPT_ROOT}/FIRST_LOGIN.txt" <<EOF
Central Apps Hub — primeiro acesso
=================================
URL local:  http://127.0.0.1:8081/central-apps-hub/
API health: http://127.0.0.1:${HUB_PORT}/health
Usuario:    ${AUTH_USER}
Senha:      ${AUTH_PASS}

Guarde esta senha e apague este arquivo depois:
  sudo rm ${OPT_ROOT}/FIRST_LOGIN.txt
EOF
  chmod 600 "${OPT_ROOT}/FIRST_LOGIN.txt"
  chown root:root "${OPT_ROOT}/FIRST_LOGIN.txt"
  echo "Credenciais iniciais em ${OPT_ROOT}/FIRST_LOGIN.txt"
else
  echo ".env existente preservado"
  # garante HUB_RUNTIME
  grep -q '^HUB_RUNTIME=' "$ENV_FILE" || echo 'HUB_RUNTIME=appliance' >> "$ENV_FILE"
fi

# Postgres compose env
mkdir -p /opt/postgres
DB_PASS_LINE="$(grep -E '^DATABASE_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
cat > /opt/postgres/.env <<EOF
POSTGRES_USER=postgres
POSTGRES_PASSWORD=${DB_PASS_LINE}
POSTGRES_DB=postgres
EOF
chmod 600 /opt/postgres/.env
chown "${HUB_USER}:${HUB_USER}" /opt/postgres/.env

echo "==> Infra Docker (Postgres + Apache)"
cp "${BACKEND_DST}/deploy/postgres/docker-compose.yml" /opt/postgres/docker-compose.yml
# Bind localhost no appliance
if grep -q '"5433:5432"' /opt/postgres/docker-compose.yml; then
  sed -i 's/"5433:5432"/"127.0.0.1:5433:5432"/' /opt/postgres/docker-compose.yml || true
fi
cp "${BACKEND_DST}/deploy/apache/docker-compose.yml" /opt/apache/docker-compose.yml
if [[ ! -f /opt/apache/hub.conf ]]; then
  cp "${BACKEND_DST}/deploy/apache/hub.conf" /opt/apache/hub.conf
fi
if [[ -f "${BACKEND_DST}/deploy/apache/redeploy.sh" ]]; then
  cp "${BACKEND_DST}/deploy/apache/redeploy.sh" /opt/apache/redeploy.sh
  chmod +x /opt/apache/redeploy.sh
fi
chown -R "${HUB_USER}:${HUB_USER}" /opt/apache /opt/postgres

# mem_limit explicito
python3 - <<'PY' || true
from pathlib import Path
for path in (Path("/opt/apache/docker-compose.yml"), Path("/opt/postgres/docker-compose.yml")):
    text = path.read_text()
    if "mem_limit:" in text:
        continue
    # injeta apos container_name se existir
    lines = text.splitlines()
    out = []
    for i, line in enumerate(lines):
        out.append(line)
        if line.strip().startswith("container_name:") and i + 1 < len(lines) and "mem_limit" not in "\n".join(lines[i:i+5]):
            indent = "    "
            if "apache" in path.name or "httpd" in text:
                out.append(f"{indent}mem_limit: 256m")
            else:
                out.append(f"{indent}mem_limit: 512m")
    path.write_text("\n".join(out) + "\n")
PY

runuser -u "$HUB_USER" -- bash -lc 'cd /opt/postgres && docker compose --env-file .env up -d --remove-orphans'
runuser -u "$HUB_USER" -- bash -lc 'cd /opt/apache && docker compose up -d --remove-orphans'

echo "==> Aguardando Postgres"
for i in $(seq 1 40); do
  if docker exec postgres pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
# cria database do Hub
DB_NAME="$(grep -E '^DATABASE_NAME=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
docker exec -e PGPASSWORD="$DB_PASS_LINE" postgres \
  psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || docker exec -e PGPASSWORD="$DB_PASS_LINE" postgres psql -U postgres -c "CREATE DATABASE ${DB_NAME};"

echo "==> Build backend + frontend"
runuser -u "$HUB_USER" -- bash -lc "cd '${BACKEND_DST}' && npm ci || npm install && npm run build"
runuser -u "$HUB_USER" -- bash -lc "cd '${FRONTEND_DST}' && npm ci || npm install && npm run build"
# publica frontend no Apache
mkdir -p "/hub-apps/apache/${APP_NAME}"
rsync -a --delete "${FRONTEND_DST}/dist/" "/hub-apps/apache/${APP_NAME}/"
chown -R "${HUB_USER}:${HUB_USER}" "/hub-apps/apache/${APP_NAME}"

echo "==> hubctl + systemd"
install -m 0755 "${SCRIPT_DIR}/hubctl" /usr/local/bin/hubctl
install -m 0755 "${SCRIPT_DIR}/hub-bootstrap.sh" /usr/local/lib/central-apps-hub/hub-bootstrap.sh 2>/dev/null \
  || (mkdir -p /usr/local/lib/central-apps-hub && install -m 0755 "${SCRIPT_DIR}/hub-bootstrap.sh" /usr/local/lib/central-apps-hub/hub-bootstrap.sh)
install -m 0644 "${SCRIPT_DIR}/hub.service" /etc/systemd/system/hub.service
systemctl daemon-reload
systemctl enable hub.service
systemctl restart hub.service
# Bootstrap nao e mais necessario apos install manual/completo
systemctl disable hub-bootstrap.service 2>/dev/null || true


echo "==> Health"
ready=0
for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${HUB_PORT}/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

echo
echo "========================================"
if [[ "$ready" -eq 1 ]]; then
  echo " Hub appliance instalado"
else
  echo " Hub instalado, mas /health ainda nao respondeu"
  echo " Veja: journalctl -u hub -e"
fi
echo " UI:     http://127.0.0.1:8081/${APP_NAME}/"
echo " Login:  ${OPT_ROOT}/FIRST_LOGIN.txt (se gerado agora)"
echo " Ctrl:   hubctl status | hubctl restart | hubctl logs"
echo "========================================"
