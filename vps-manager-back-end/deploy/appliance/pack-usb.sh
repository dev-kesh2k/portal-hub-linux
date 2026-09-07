#!/usr/bin/env bash
# Empacota backend + frontend + installer num tarball para pendrive / VM.
# Rode no Windows (Git Bash) ou WSL a partir do repo backend.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FRONTEND="${FRONTEND_DIR:-$(cd "${BACKEND}/../vps-manager-front-end" 2>/dev/null && pwd || true)}"
OUT_DIR="${1:-${BACKEND}/dist-appliance}"
STAMP="$(date +%Y%m%d)"
NAME="central-apps-hub-appliance-${STAMP}"
STAGE="${OUT_DIR}/${NAME}"

if [[ ! -f "${BACKEND}/package.json" ]]; then
  echo "Backend nao encontrado" >&2
  exit 1
fi
if [[ -z "$FRONTEND" || ! -f "${FRONTEND}/package.json" ]]; then
  echo "Frontend nao encontrado ao lado do backend (vps-manager-front-end)" >&2
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$STAGE/vps-manager-back-end" "$STAGE/vps-manager-front-end"

echo "==> Copiando backend"
rsync -a \
  --exclude node_modules --exclude dist --exclude .git --exclude .env \
  --exclude backend.log --exclude backend.pid --exclude dist-upload --exclude dist-appliance \
  "${BACKEND}/" "$STAGE/vps-manager-back-end/"

echo "==> Copiando frontend"
rsync -a \
  --exclude node_modules --exclude dist --exclude .git --exclude .env \
  "${FRONTEND}/" "$STAGE/vps-manager-front-end/"

cat > "$STAGE/INSTALAR.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec sudo bash "$ROOT/vps-manager-back-end/deploy/appliance/install.sh" \
  --backend "$ROOT/vps-manager-back-end" \
  --frontend "$ROOT/vps-manager-front-end" \
  "$@"
EOF
chmod +x "$STAGE/INSTALAR.sh"

cat > "$STAGE/LEIA-ME.txt" <<EOF
Central Apps Hub — pacote appliance
===================================

Requisitos da maquina destino:
  - Ubuntu Server 22.04 ou 24.04 (instalacao limpa)
  - Internet (Docker + Node na primeira instalacao)
  - 2+ CPU, 4+ GB RAM, 20+ GB disco

Instalar:
  1. Copie esta pasta para a maquina (USB, scp, etc.)
  2. sudo bash INSTALAR.sh
  3. Abra http://IP-DA-MAQUINA:8081/central-apps-hub/
  4. Credenciais em /opt/central-apps-hub/FIRST_LOGIN.txt

Comandos:
  sudo hubctl status
  sudo hubctl restart
  sudo hubctl logs

Proximo passo (ISO/USB bootavel): ver
  vps-manager-back-end/deploy/appliance/autoinstall/README.md
EOF

mkdir -p "$OUT_DIR"
TAR="${OUT_DIR}/${NAME}.tar.gz"
tar -C "$OUT_DIR" -czf "$TAR" "$NAME"
echo
echo "Pacote: $TAR"
echo "Pasta:  $STAGE"
ls -lh "$TAR"
