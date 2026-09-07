#!/usr/bin/env bash
# Gera ISO Ubuntu Server + autoinstall + Hub (requer WSL/Linux com xorriso e ISO baixada).
# Uso:
#   bash build-iso.sh /caminho/ubuntu-24.04-live-server-amd64.iso
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLIANCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND="$(cd "${APPLIANCE_DIR}/../.." && pwd)"
SRC_ISO="${1:-}"
WORK="${BACKEND}/dist-appliance/iso-work"
OUT_ISO="${BACKEND}/dist-appliance/central-apps-hub-ubuntu-24.04.iso"

if [[ -z "$SRC_ISO" || ! -f "$SRC_ISO" ]]; then
  echo "Uso: $0 /caminho/ubuntu-24.04.3-live-server-amd64.iso" >&2
  echo "Baixe em: https://ubuntu.com/download/server" >&2
  exit 1
fi

if ! command -v xorriso >/dev/null 2>&1; then
  echo "Instale xorriso: sudo apt-get install -y xorriso isolate" >&2
  exit 1
fi

bash "${SCRIPT_DIR}/prepare-usb-media.sh"
MEDIA="${BACKEND}/dist-appliance/usb-media"

rm -rf "$WORK"
mkdir -p "$WORK"
echo "==> Extraindo ISO (somente leitura via xorriso copy)"
xorriso -osirrox on -indev "$SRC_ISO" -extract / "$WORK/iso"

echo "==> Copiando nocloud + Hub"
mkdir -p "$WORK/iso/nocloud" "$WORK/iso/hub-payload"
cp -a "$MEDIA/nocloud/." "$WORK/iso/nocloud/"
cp -a "$MEDIA/hub-payload/." "$WORK/iso/hub-payload/"
cp -f "$MEDIA/hub-payload.tar.gz" "$WORK/iso/hub-payload.tar.gz" 2>/dev/null || true

# GRUB: adiciona autoinstall nas entradas de boot
for grub in "$WORK/iso/boot/grub/grub.cfg" "$WORK/iso/grub/grub.cfg"; do
  [[ -f "$grub" ]] || continue
  if ! grep -q 'ds=nocloud' "$grub"; then
    sed -i 's|---|autoinstall ds=nocloud\;s=/cdrom/nocloud/ ---|g' "$grub" || true
  fi
done

# Alguns ISOs usam isolinux
for cfg in "$WORK/iso/isolinux/txt.cfg" "$WORK/iso/isolinux/isolinux.cfg"; do
  [[ -f "$cfg" ]] || continue
  if ! grep -q 'ds=nocloud' "$cfg"; then
    sed -i 's|---|autoinstall ds=nocloud\;s=/cdrom/nocloud/ ---|g' "$cfg" || true
  fi
done

echo "==> Gerando ISO"
rm -f "$OUT_ISO"
xorriso -as mkisofs \
  -r -V "CAH-Ubuntu-Hub" \
  -o "$OUT_ISO" \
  -J -joliet-long \
  -l \
  -iso-level 3 \
  -partition_offset 16 \
  --grub2-mbr --interval:local_fs:0s-15s:zero_mbrpt,zero_gpt:"$SRC_ISO" \
  --protective-msdos-label \
  -append_partition 2 28732ac11ff8d211ba4b00a0c93ec93b --interval:local_fs:2698848d-2709027d::"$SRC_ISO" \
  -appended_part_as_gpt \
  -c /boot.catalog \
  -b /boot/grub/i386-pc/eltorito.img \
  -no-emul-boot -boot-load-size 4 -boot-info-table --grub2-boot-info \
  -eltorito-alt-boot \
  -e '--interval:appended_partition_2_start_1024k_size_942080d:all::' \
  -no-emul-boot \
  "$WORK/iso" 2>/dev/null || {
  echo "Fallback mkisofs simples (VM/BIOS legado)..."
  xorriso -as mkisofs -r -V "CAH-Ubuntu-Hub" -o "$OUT_ISO" \
    -J -l -b boot/grub/i386-pc/eltorito.img -c boot.catalog \
    -no-emul-boot -boot-load-size 4 -boot-info-table \
    "$WORK/iso"
}

echo
echo "ISO pronta: $OUT_ISO"
ls -lh "$OUT_ISO"
echo "Grave com Rufus (DD) no pendrive e boot na maquina nova."
echo "1o boot apos install: Hub instala sozinho. Boots seguintes: Hub sobe sozinho."
