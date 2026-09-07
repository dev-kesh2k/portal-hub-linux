#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${BACKEND_DIR:-$SCRIPT_DIR}"
FRONTEND_DIR="${FRONTEND_DIR:-$SCRIPT_DIR/../vps-manager-front-end}"
MODE="${MODE:-prod}"
PROJECT="${PROJECT:-central-apps-hub}"

for arg in "$@"; do
  case "$arg" in
    --dev) MODE="dev" ;;
    --prod) MODE="prod" ;;
  esac
done

if [[ ! -f "$BACKEND_DIR/package.json" ]]; then
  echo "Backend não encontrado em: $BACKEND_DIR"
  exit 1
fi

if [[ ! -f "$FRONTEND_DIR/package.json" ]]; then
  echo "Frontend não encontrado em: $FRONTEND_DIR"
  echo "Clone também o repositório vps-manager-front-end ao lado do backend."
  exit 1
fi

BACKEND_DIR="$(cd "$BACKEND_DIR" && pwd)"
FRONTEND_DIR="$(cd "$FRONTEND_DIR" && pwd)"

WSL_EXE=""
DOCKER_VIA_WSL=0
BACKEND_PID=""
FRONTEND_PID=""

load_dotenv() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
    fi
  done < "$file"
}

ensure_env_file() {
  if [[ -f "$BACKEND_DIR/.env" ]]; then
    return 0
  fi
  if [[ -f "$BACKEND_DIR/.env.example" ]]; then
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
    echo "Criado $BACKEND_DIR/.env a partir do .env.example."
    echo "Copie o .env da máquina antiga (tokens Cloudflare, senhas) para o domínio funcionar."
  else
    echo "Arquivo .env não encontrado em $BACKEND_DIR"
    exit 1
  fi
}

is_wsl_guest() {
  [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null
}

is_windows_host() {
  case "${OSTYPE:-}" in
    msys*|cygwin*|win32*) return 0 ;;
  esac
  [[ -n "${WINDIR:-}" ]] && return 0
  is_wsl_guest
}

find_wsl_exe() {
  if command -v wsl.exe >/dev/null 2>&1; then
    command -v wsl.exe
    return 0
  fi
  local candidate
  for candidate in \
    /mnt/c/Windows/System32/wsl.exe \
    /c/Windows/System32/wsl.exe \
    "${WINDIR:-}/System32/wsl.exe"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

to_wsl_path() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    p="$(cygpath -u "$p")"
  fi
  p="${p//\\//}"
  if [[ "$p" =~ ^/mnt/[a-zA-Z]/ ]]; then
    echo "$p"
    return 0
  fi
  if [[ "$p" =~ ^/([a-zA-Z])/(.*)$ ]]; then
    echo "/mnt/${BASH_REMATCH[1],,}/${BASH_REMATCH[2]}"
    return 0
  fi
  echo "$p"
}

wsl_text() {
  "$WSL_EXE" "$@" 2>/dev/null | tr -d '\0' | tr -d '\r'
}

wsl_distros() {
  wsl_text -l -q | sed '/^$/d'
}

wsl_has_distro() {
  local want="$1"
  wsl_distros | grep -qiE "^${want}$"
}

wsl_needs_reboot() {
  local out
  out="$(wsl_text --status || true)$(wsl_text -l -v || true)"
  echo "$out" | grep -qiE 'reboot|restart|reinicie'
}

as_root() {
  if [[ "${EUID:-1}" -eq 0 ]]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo "$@"
    return
  fi
  if [[ -n "${WSL_EXE:-}" ]]; then
    "$WSL_EXE" -d "$WSL_DISTRO" -u root -- "$@"
    return
  fi
  sudo "$@"
}

ensure_wsl() {
  WSL_DISTRO="${WSL_DISTRO:-Ubuntu}"

  if is_wsl_guest; then
    WSL_EXE="$(find_wsl_exe || true)"
    echo "WSL: já estamos dentro de ${WSL_DISTRO_NAME:-$WSL_DISTRO}"
    return 0
  fi

  if ! is_windows_host; then
    echo "Linux nativo: pulando instalação do WSL."
    return 0
  fi

  if ! WSL_EXE="$(find_wsl_exe)"; then
    echo "WSL: wsl.exe não encontrado. No PowerShell como Administrador:"
    echo "  wsl --install -d ${WSL_DISTRO}"
    echo "Reinicie o Windows Server e rode ./start.sh de novo."
    exit 1
  fi

  if wsl_needs_reboot; then
    echo "WSL: reinicie o Windows Server e rode ./start.sh de novo."
    exit 1
  fi

  if ! wsl_distros >/dev/null 2>&1; then
    echo "WSL: instalando o runtime (pode pedir administrador)..."
    if ! "$WSL_EXE" --install --no-distribution; then
      echo "Falha ao instalar o WSL. No PowerShell como Administrador:"
      echo "  wsl --install -d ${WSL_DISTRO}"
      exit 1
    fi
    echo "Reinicie o Windows Server e rode ./start.sh de novo."
    exit 1
  fi

  if ! wsl_has_distro "$WSL_DISTRO"; then
    local detected
    detected="$(wsl_distros | grep -i '^Ubuntu' | head -n 1 || true)"
    if [[ -n "$detected" ]]; then
      WSL_DISTRO="$detected"
      echo "WSL: usando distro já instalada: ${WSL_DISTRO}"
    else
      echo "WSL: instalando distro ${WSL_DISTRO}..."
      if ! "$WSL_EXE" --install -d "$WSL_DISTRO" --no-launch --web-download \
        && ! "$WSL_EXE" --install -d "$WSL_DISTRO" --no-launch \
        && ! "$WSL_EXE" --install -d "$WSL_DISTRO"; then
        echo "Falha ao instalar ${WSL_DISTRO}. No PowerShell como Administrador:"
        echo "  wsl --install -d ${WSL_DISTRO}"
        exit 1
      fi
      if wsl_needs_reboot || ! wsl_has_distro "$WSL_DISTRO"; then
        echo "Reinicie o Windows Server (ou termine o setup do Ubuntu) e rode ./start.sh de novo."
        exit 1
      fi
    fi
  fi

  "$WSL_EXE" --set-default-version 2 >/dev/null 2>&1 || true
  "$WSL_EXE" --set-default "$WSL_DISTRO" >/dev/null 2>&1 || true
  echo "WSL: iniciando ${WSL_DISTRO}..."
  if ! "$WSL_EXE" -d "$WSL_DISTRO" --exec /bin/true >/dev/null 2>&1; then
    echo "Abra o Ubuntu uma vez para criar o usuário Linux e rode ./start.sh de novo."
    exit 1
  fi
  echo "WSL: ${WSL_DISTRO} pronto"
}

reexec_in_wsl() {
  if is_wsl_guest || ! is_windows_host || [[ -z "${WSL_EXE:-}" ]]; then
    return 0
  fi
  local dir_wsl mode_flag
  dir_wsl="$(to_wsl_path "$SCRIPT_DIR")"
  mode_flag="--prod"
  [[ "$MODE" == "dev" ]] && mode_flag="--dev"
  echo "WSL: continuando o setup dentro do Ubuntu..."
  echo "     $dir_wsl"
  if ! "$WSL_EXE" -d "$WSL_DISTRO" -- bash -lc "export KEEP_WINDOW_OPEN=1; cd $(printf '%q' "$dir_wsl") && sed -i 's/\r$//' ./start.sh && bash ./start.sh ${mode_flag}; code=\$?; echo; echo \"Codigo de saida: \$code\"; echo; read -r -p 'Pressione Enter para fechar... '; exit \$code"; then
    echo
    echo "Falha ao iniciar o Ubuntu. No PowerShell como Administrador:"
    echo "  wsl --install -d Ubuntu"
    echo
    read -r -p "Pressione Enter para fechar..." || true
    exit 1
  fi
  exit 0
}

prefer_linux_paths() {
  if is_wsl_guest || [[ "$(uname -s)" == "Linux" ]]; then
    export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
    hash -r || true
  fi
}

linux_npm() {
  local npm_bin
  npm_bin="$(command -v npm 2>/dev/null || true)"
  [[ -n "$npm_bin" && "$npm_bin" != /mnt/* && "$npm_bin" != /c/* ]]
}

ensure_node() {
  prefer_linux_paths
  if linux_npm; then
    echo "Node.js: $(command -v node) ($(node -v 2>/dev/null || echo ok))"
    return 0
  fi
  if is_wsl_guest || [[ "$(uname -s)" == "Linux" ]]; then
    echo "Node.js: instalando no Ubuntu (não usar o Node do Windows)..."
    as_root bash -lc '
      set -e
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y ca-certificates curl gnupg build-essential python3
      if ! command -v npm >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
      fi
    '
    prefer_linux_paths
    if linux_npm; then
      echo "Node.js: $(command -v node) ($(node -v))"
      return 0
    fi
  fi
  if command -v npm >/dev/null 2>&1; then
    echo "Node.js: usando npm do PATH ($(command -v npm))"
    return 0
  fi
  echo "Node.js/npm não encontrados. Instale o Node.js 20+ e rode ./start.sh de novo."
  exit 1
}

docker_available() {
  command -v docker >/dev/null 2>&1 || command -v docker.exe >/dev/null 2>&1
}

docker_sh() {
  if [[ "$DOCKER_VIA_WSL" == "1" && -n "${WSL_EXE:-}" ]]; then
    "$WSL_EXE" -d "$WSL_DISTRO" -u root -- docker "$@"
  elif command -v docker >/dev/null 2>&1; then
    docker "$@"
  else
    docker.exe "$@"
  fi
}

ensure_docker() {
  if docker_available && docker info >/dev/null 2>&1; then
    DOCKER_VIA_WSL=0
    echo "Docker: usando o cliente local"
    return 0
  fi

  if is_wsl_guest || [[ "$(uname -s)" == "Linux" ]]; then
    echo "Docker: instalando engine no Ubuntu..."
    as_root bash -lc '
      set -e
      export DEBIAN_FRONTEND=noninteractive
      if ! command -v docker >/dev/null 2>&1; then
        apt-get update -qq
        apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io
      fi
      (service docker start || systemctl start docker || true) >/dev/null 2>&1
      for i in $(seq 1 20); do
        docker info >/dev/null 2>&1 && exit 0
        sleep 1
      done
      echo "Docker não iniciou"
      exit 1
    '
    DOCKER_VIA_WSL=0
    echo "Docker: pronto"
    return 0
  fi

  echo "Docker não encontrado. Instale o Docker e rode ./start.sh de novo."
  exit 1
}

postgres_ready() {
  docker_sh exec "$POSTGRES_CONTAINER" pg_isready -U "$DATABASE_USER" -q >/dev/null 2>&1 && return 0
  docker_sh exec "$POSTGRES_CONTAINER" psql -U "$DATABASE_USER" -d postgres -c 'SELECT 1' >/dev/null 2>&1 && return 0
  return 1
}

ensure_database() {
  if docker_sh exec "$POSTGRES_CONTAINER" psql -U "$DATABASE_USER" -d postgres -tc \
    "SELECT 1 FROM pg_database WHERE datname='${DATABASE_NAME}'" 2>/dev/null | grep -q 1; then
    return 0
  fi
  echo "PostgreSQL: criando banco ${DATABASE_NAME}..."
  docker_sh exec "$POSTGRES_CONTAINER" psql -U "$DATABASE_USER" -d postgres \
    -c "CREATE DATABASE ${DATABASE_NAME};" >/dev/null
}

ensure_postgres_container() {
  if docker_sh ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$POSTGRES_CONTAINER"; then
    echo "PostgreSQL: iniciando container ${POSTGRES_CONTAINER}..."
    docker_sh start "$POSTGRES_CONTAINER" >/dev/null
    return 0
  fi
  echo "PostgreSQL: criando container ${POSTGRES_CONTAINER} (porta ${DATABASE_PORT})..."
  docker_sh run -d \
    --name "$POSTGRES_CONTAINER" \
    --restart unless-stopped \
    -e "POSTGRES_USER=${DATABASE_USER}" \
    -e "POSTGRES_PASSWORD=${DATABASE_PASSWORD}" \
    -e "POSTGRES_DB=${DATABASE_NAME}" \
    -p "${DATABASE_PORT}:5432" \
    postgres:16 >/dev/null
}

wait_for_postgres() {
  local wait_s attempt
  wait_s="$(awk "BEGIN { printf \"%.3f\", ${DATABASE_WAIT_MS}/1000 }")"
  ensure_postgres_container
  for attempt in $(seq 1 "$DATABASE_WAIT_ATTEMPTS"); do
    if postgres_ready; then
      echo "PostgreSQL: pronto"
      ensure_database
      return 0
    fi
    echo "PostgreSQL: aguardando inicialização (${attempt}/${DATABASE_WAIT_ATTEMPTS})"
    sleep "$wait_s"
  done
  echo "PostgreSQL não ficou pronto a tempo em ${DATABASE_HOST}:${DATABASE_PORT}."
  exit 1
}

ensure_deps() {
  local dir="$1"
  echo "Dependências: $dir"
  (cd "$dir" && npm install)
}

reinstall_native_modules() {
  local dir="$1"
  echo "Reinstalando módulos nativos para Linux em $dir..."
  (cd "$dir" && rm -rf node_modules && npm install)
}

ensure_deps_prod() {
  if [[ ! -d "$BACKEND_DIR/node_modules" ]] || ! (cd "$BACKEND_DIR" && node -e "require('node-pty')" >/dev/null 2>&1); then
    reinstall_native_modules "$BACKEND_DIR"
  fi
  if [[ ! -d "$FRONTEND_DIR/node_modules" ]] \
    || [[ ! -d "$FRONTEND_DIR/node_modules/@rollup/rollup-linux-x64-gnu" ]] \
    || [[ ! -d "$FRONTEND_DIR/node_modules/@esbuild/linux-x64" ]]; then
    reinstall_native_modules "$FRONTEND_DIR"
  fi
}

publish_frontend() {
  echo "Frontend: build de produção..."
  (cd "$FRONTEND_DIR" && npm run build)

  echo "Apache: publicando em /hub-apps/apache/${PROJECT}..."
  as_root mkdir -p "/hub-apps/apache/${PROJECT}" /hub-apps/servicos /opt/apache
  as_root bash -lc "rm -rf /hub-apps/apache/${PROJECT}/*"
  as_root cp -a "$FRONTEND_DIR/dist/." "/hub-apps/apache/${PROJECT}/"
  as_root chmod -R a+rX "/hub-apps/apache/${PROJECT}"
  as_root cp "$BACKEND_DIR/deploy/apache/hub.conf" /opt/apache/hub.conf
  as_root cp "$BACKEND_DIR/deploy/apache/docker-compose.yml" /opt/apache/docker-compose.yml
  as_root cp "$BACKEND_DIR/deploy/apache/redeploy.sh" /opt/apache/redeploy.sh
  as_root chmod +x /opt/apache/redeploy.sh
}

ensure_apache() {
  if [[ -z "${WINHOST:-}" || "${WINHOST}" == "host-gateway" ]]; then
    WINHOST="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4; exit}' | cut -d/ -f1 || true)"
  fi
  if [[ -z "${WINHOST:-}" ]]; then
    WINHOST="$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}'; true)"
  fi
  export WINHOST="${WINHOST:-host-gateway}"
  echo "Apache: subindo container na porta 8081 (backend via ${WINHOST})..."
  as_root bash -lc "cd /opt/apache && export WINHOST='${WINHOST}'; docker compose up -d --force-recreate || docker-compose up -d --force-recreate"
  sleep 2
  curl -s --max-time 5 -o /dev/null -w "Apache /${PROJECT}/ -> %{http_code}\n" "http://127.0.0.1:8081/${PROJECT}/" || true
}

ensure_backend_prod() {
  local pid_file="$BACKEND_DIR/backend.pid"
  local log_file="$BACKEND_DIR/backend.log"
  echo "Backend: encerrando processo anterior na porta ${PORT}..."
  if [[ -s "$pid_file" ]]; then
    kill "$(cat "$pid_file")" 2>/dev/null || true
    rm -f "$pid_file"
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti ":${PORT}" | xargs -r kill >/dev/null 2>&1 || true
  fi
  sleep 1

  echo "Backend: build de produção..."
  (cd "$BACKEND_DIR" && npm run build)

  echo "Backend: iniciando em 0.0.0.0:${PORT} (node dist)..."
  (
    cd "$BACKEND_DIR"
    setsid env PATH="/usr/bin:/usr/local/bin:/bin:$PATH" node dist/index.js </dev/null >"$log_file" 2>&1 &
    echo $! >"$pid_file"
  )
  sleep 3
  if ! kill -0 "$(cat "$pid_file" 2>/dev/null)" 2>/dev/null; then
    echo "Backend falhou ao iniciar. Veja $log_file"
    tail -n 40 "$log_file" || true
    exit 1
  fi
  local ready=0
  local i
  for i in $(seq 1 40); do
    if curl -sf --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "Backend subiu, mas /health não respondeu. Veja $log_file"
    tail -n 40 "$log_file" || true
  else
    echo "Backend: http://127.0.0.1:${PORT}/health ok"
  fi
}

fetch_cf_tunnel_token() {
  if [[ -n "${CF_TUNNEL_TOKEN:-}" ]]; then
    return 0
  fi
  if [[ -z "${CF_API_TOKEN:-}" || -z "${CF_ACCOUNT_ID:-}" || -z "${CF_TUNNEL_ID:-}" ]]; then
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1 && ! command -v curl >/dev/null 2>&1; then
    return 1
  fi
  local json
  json="$(curl -sS -H "Authorization: Bearer ${CF_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}/token" || true)"
  CF_TUNNEL_TOKEN="$(printf '%s' "$json" | python3 -c 'import json,sys
d=json.load(sys.stdin)
r=d.get("result")
print(r if isinstance(r, str) else "")' 2>/dev/null || true)"
  [[ -n "${CF_TUNNEL_TOKEN:-}" ]]
}

ensure_tunnel_hostname() {
  if [[ -z "${CF_API_TOKEN:-}" || -z "${CF_ACCOUNT_ID:-}" || -z "${CF_TUNNEL_ID:-}" ]]; then
    return 0
  fi
  local host origin
  host="$(python3 -c 'from urllib.parse import urlparse; import os; print(urlparse(os.environ.get("PUBLIC_ORIGIN","https://central-apps-hub.com.br")).hostname or "central-apps-hub.com.br")')"
  origin="${CF_ORIGIN_SERVICE:-http://127.0.0.1:8081}"
  echo "Cloudflare: sincronizando túnel ${host} -> ${origin}"
  CF_HOST="$host" CF_ORIGIN="$origin" python3 - <<'PY'
import json, os, urllib.request
account = os.environ["CF_ACCOUNT_ID"]
tunnel = os.environ["CF_TUNNEL_ID"]
token = os.environ["CF_API_TOKEN"]
host = os.environ["CF_HOST"]
origin = os.environ["CF_ORIGIN"]
reserved = {"api", "health", "ws", "central-apps-hub", "www"}
url = f"https://api.cloudflare.com/client/v4/accounts/{account}/cfd_tunnel/{tunnel}/configurations"
req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
with urllib.request.urlopen(req) as res:
    body = json.load(res)
config = (body.get("result") or {}).get("config") or {}
current = list(config.get("ingress") or [])
paths = []
seen = set()
for rule in current:
    if rule.get("hostname") != host:
        continue
    path = str(rule.get("path") or "").rstrip("*").strip("/")
    if not path or path in reserved:
        continue
    key = f"/{path}"
    if key in seen:
        continue
    seen.add(key)
    paths.append({"hostname": host, "path": key, "service": origin})
ingress = paths + [{"hostname": host, "service": origin}, {"service": "http_status:404"}]
config["ingress"] = ingress
put = urllib.request.Request(url, data=json.dumps({"config": config}).encode(), method="PUT",
                             headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
with urllib.request.urlopen(put) as res:
    json.load(res)
print("Cloudflare: túnel sincronizado")
PY
}

ensure_cloudflared() {
  if docker_sh inspect -f '{{.State.Running}}' cloudflared 2>/dev/null | grep -qi true; then
    echo "Cloudflare: cloudflared já está em execução"
    ensure_tunnel_hostname || true
    return 0
  fi
  if ! fetch_cf_tunnel_token; then
    echo "Cloudflare: sem CF_TUNNEL_TOKEN / API. O domínio público não vai entrar até o túnel subir."
    echo "Copie o .env da máquina antiga (CF_API_TOKEN, CF_ACCOUNT_ID, CF_TUNNEL_ID) e rode de novo."
    return 0
  fi
  echo "Cloudflare: iniciando cloudflared..."
  docker_sh rm -f cloudflared >/dev/null 2>&1 || true
  if ! docker_sh run -d \
    --name cloudflared \
    --restart always \
    --network host \
    cloudflare/cloudflared:latest tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" >/dev/null; then
    docker_sh run -d \
      --name cloudflared \
      --restart always \
      --add-host=host.docker.internal:host-gateway \
      cloudflare/cloudflared:latest tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" >/dev/null
  fi
  ensure_tunnel_hostname
}

start_dev() {
  trap cleanup EXIT INT TERM
  ensure_deps "$BACKEND_DIR"
  ensure_deps "$FRONTEND_DIR"
  wait_for_postgres
  echo "Iniciando backend  -> $BACKEND_DIR"
  (cd "$BACKEND_DIR" && npm run dev) &
  BACKEND_PID=$!
  echo "Iniciando frontend -> $FRONTEND_DIR"
  (cd "$FRONTEND_DIR" && npm run dev) &
  FRONTEND_PID=$!
  echo
  echo "Backend:  http://localhost:${PORT}"
  echo "Frontend: http://localhost:5173"
  echo "Ctrl+C encerra os dois processos."
  echo
  wait
}

start_prod() {
  ensure_deps_prod
  wait_for_postgres
  publish_frontend
  ensure_backend_prod
  ensure_apache
  ensure_cloudflared
  echo
  echo "========================================"
  echo " Hub publicado"
  echo " Local:   http://127.0.0.1:8081/${PROJECT}/"
  echo " Domínio: ${PUBLIC_ORIGIN}/${PROJECT}/"
  echo " API:     http://127.0.0.1:${PORT}/health"
  echo " Log:     $BACKEND_DIR/backend.log"
  echo "========================================"
  echo "Pare o cloudflared da máquina antiga para o túnel não ficar dividido."
  echo
  keep_window_open
}

cleanup() {
  echo
  echo "Encerrando processos de desenvolvimento..."
  [[ -n "$BACKEND_PID" ]] && kill "$BACKEND_PID" 2>/dev/null || true
  [[ -n "$FRONTEND_PID" ]] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}

keep_window_open() {
  if [[ "${KEEP_WINDOW_OPEN:-0}" == "1" ]]; then
    echo
    read -r -p "Pressione Enter para fechar..." || true
  fi
}

on_error() {
  local code=$?
  echo
  echo "ERRO: o script parou (codigo ${code}) na linha ${BASH_LINENO[0]:-?}."
  keep_window_open
  exit "$code"
}
trap on_error ERR

ensure_env_file
load_dotenv "$BACKEND_DIR/.env"

DATABASE_HOST="${DATABASE_HOST:-127.0.0.1}"
DATABASE_PORT="${DATABASE_PORT:-5433}"
DATABASE_USER="${DATABASE_USER:-postgres}"
DATABASE_PASSWORD="${DATABASE_PASSWORD:-postgres}"
DATABASE_NAME="${DATABASE_NAME:-central_apps_hub}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-postgres}"
DATABASE_WAIT_ATTEMPTS="${DATABASE_WAIT_ATTEMPTS:-30}"
DATABASE_WAIT_MS="${DATABASE_WAIT_MS:-1000}"
WSL_DISTRO="${WSL_DISTRO:-Ubuntu}"
PORT="${PORT:-3001}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://central-apps-hub.com.br}"
CF_ORIGIN_SERVICE="${CF_ORIGIN_SERVICE:-http://127.0.0.1:8081}"
WINHOST="${WINHOST:-host-gateway}"

ensure_wsl
reexec_in_wsl
prefer_linux_paths
ensure_node
ensure_docker

if [[ "$MODE" == "dev" ]]; then
  start_dev
else
  start_prod
fi
