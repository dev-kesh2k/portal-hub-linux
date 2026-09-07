#!/usr/bin/env bash
# Monta a pasta pronta para gravar no pendrive / injetar na ISO.
# Resultado: dist-appliance/usb-media/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLIANCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND="$(cd "${APPLIANCE_DIR}/../.." && pwd)"
OUT="${BACKEND}/dist-appliance/usb-media"

echo "==> Empacotando Hub"
bash "${APPLIANCE_DIR}/pack-usb.sh" >/dev/null
TAR="$(ls -1t "${BACKEND}/dist-appliance"/central-apps-hub-appliance-*.tar.gz | head -1)"
STAGE_NAME="$(basename "$TAR" .tar.gz)"

rm -rf "$OUT"
mkdir -p "$OUT/nocloud" "$OUT/hub-payload"

echo "==> Autoinstall (Ubuntu)"
cp "${SCRIPT_DIR}/user-data" "$OUT/nocloud/user-data"
cp "${SCRIPT_DIR}/meta-data" "$OUT/nocloud/meta-data"
cp "${APPLIANCE_DIR}/hub-bootstrap.sh" "$OUT/nocloud/hub-bootstrap.sh"
cp "${APPLIANCE_DIR}/hub-bootstrap.service" "$OUT/nocloud/hub-bootstrap.service"
chmod +x "$OUT/nocloud/hub-bootstrap.sh"

echo "==> Payload do Hub"
tar -xzf "$TAR" -C "$OUT/hub-payload" --strip-components=1
# garante INSTALAR.sh na raiz do payload
if [[ ! -f "$OUT/hub-payload/INSTALAR.sh" ]]; then
  # se strip falhou, move de dentro
  found="$(find "$OUT/hub-payload" -maxdepth 2 -name INSTALAR.sh | head -1 || true)"
  if [[ -n "$found" ]]; then
    root="$(dirname "$found")"
    shopt -s dotglob
    mkdir -p "$OUT/hub-payload-tmp"
    mv "$root"/* "$OUT/hub-payload-tmp/" 2>/dev/null || true
    rm -rf "$OUT/hub-payload"
    mv "$OUT/hub-payload-tmp" "$OUT/hub-payload"
  fi
fi
chmod +x "$OUT/hub-payload/INSTALAR.sh" 2>/dev/null || true
cp "$TAR" "$OUT/hub-payload.tar.gz"

# GRUB snippet para lembrar o parametro de boot
cat > "$OUT/nocloud/grub-snippet.txt" <<'EOF'
Na linha do kernel do Ubuntu Server, acrescente (antes do ---):

  autoinstall ds=nocloud;s=/cdrom/nocloud/

Exemplo:
  linux /casper/vmlinuz autoinstall ds=nocloud;s=/cdrom/nocloud/ ---
  initrd /casper/initrd
EOF

cat > "$OUT/LEIA-ME-USB.txt" <<EOF
Central Apps Hub — midia de instalacao
======================================

O que acontece:
  1. Voce instala o Ubuntu Server a partir deste pendrive/ISO (autoinstall)
  2. No PRIMEIRO boot, o Hub se instala sozinho (Docker, portal, DB)
  3. Em TODOS os boots seguintes, o Hub sobe automaticamente (systemd)

Credenciais do SISTEMA (SSH/console):
  usuario: hubadmin
  senha:   ChangemeHub2026!

Credenciais do PORTAL Hub:
  arquivo: /opt/central-apps-hub/FIRST_LOGIN.txt
  (criado apos o primeiro boot terminar a instalacao — espere 5 a 15 min)

URL do portal:
  http://IP-DA-MAQUINA:8081/central-apps-hub/

Como gravar (Windows):
  A) Rufus / Balena: grave a ISO Ubuntu Server 24.04 no pendrive
     Depois copie as pastas "nocloud" e "hub-payload" para a raiz do pendrive
     (pode precisar de pendrive com particao extra ou editar a ISO — ver abaixo)

  B) Recomendado: use Cubic (Linux) ou o script build-iso.sh no WSL
     para gerar UMA ISO so com Ubuntu + nocloud + hub-payload.
     Depois grave essa ISO no pendrive com Rufus (modo DD).

Parametros de boot (se a ISO nao injetar sozinha):
  veja nocloud/grub-snippet.txt

Pasta gerada: ${OUT}
Pacote Hub:   ${TAR}
EOF

echo
echo "Midia pronta: $OUT"
echo "Proximos passos: abra $OUT/LEIA-ME-USB.txt"
ls -la "$OUT"
