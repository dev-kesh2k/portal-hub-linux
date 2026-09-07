#!/usr/bin/env bash
# Primeiro boot do appliance: instala o Hub se ainda nao existir, depois desativa a si mesmo.
# Em boots seguintes so o hub.service sobe a API.
set -euo pipefail

LOG=/var/log/central-apps-hub/bootstrap.log
mkdir -p /var/log/central-apps-hub
exec >>"$LOG" 2>&1

echo "=== hub-bootstrap $(date -Is) ==="

if [[ -f /opt/central-apps-hub/backend/dist/index.js ]] && systemctl is-enabled hub >/dev/null 2>&1; then
  echo "Hub ja instalado — desabilitando bootstrap"
  systemctl disable hub-bootstrap.service || true
  exit 0
fi

INSTALLER_ROOT=""
for candidate in /opt/hub-installer /opt/hub-installer/central-apps-hub-appliance-* /root/hub-installer; do
  if [[ -f "${candidate}/INSTALAR.sh" ]]; then
    INSTALLER_ROOT="$candidate"
    break
  fi
  # tarball solto
  if [[ -f "${candidate}" ]] && [[ "${candidate}" == *.tar.gz ]]; then
    mkdir -p /opt/hub-installer
    tar -xzf "$candidate" -C /opt/hub-installer
    INSTALLER_ROOT="$(find /opt/hub-installer -maxdepth 2 -type f -name INSTALAR.sh | head -1 | xargs -r dirname)"
    break
  fi
done

# Procura tarball em /opt/hub-installer
if [[ -z "$INSTALLER_ROOT" ]]; then
  tg="$(find /opt/hub-installer -maxdepth 2 -type f -name 'central-apps-hub-appliance-*.tar.gz' 2>/dev/null | head -1 || true)"
  if [[ -n "$tg" ]]; then
    tar -xzf "$tg" -C /opt/hub-installer
    INSTALLER_ROOT="$(find /opt/hub-installer -maxdepth 2 -type f -name INSTALAR.sh | head -1 | xargs dirname)"
  fi
fi

if [[ -z "$INSTALLER_ROOT" || ! -f "$INSTALLER_ROOT/INSTALAR.sh" ]]; then
  echo "Pacote do Hub nao encontrado em /opt/hub-installer" >&2
  echo "Coloque o conteudo do appliance (INSTALAR.sh) la e reinicie." >&2
  exit 1
fi

echo "Instalando a partir de $INSTALLER_ROOT"
export DEBIAN_FRONTEND=noninteractive
# Garante rede basica
sleep 5
bash "$INSTALLER_ROOT/INSTALAR.sh"

systemctl enable hub.service
systemctl restart hub.service || true
systemctl disable hub-bootstrap.service || true

echo "Bootstrap concluido $(date -Is)"
echo "Login: /opt/central-apps-hub/FIRST_LOGIN.txt"
