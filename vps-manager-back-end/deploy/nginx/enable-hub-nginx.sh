#!/usr/bin/env bash
# Rode UMA vez com sudo para o Hub poder gerenciar confs do Nginx sem senha.
# Uso: sudo bash deploy/nginx/enable-hub-nginx.sh
set -euo pipefail

HUB_NGINX_DIR="/hub-apps/nginx/conf.d"
INCLUDE_FILE="/etc/nginx/conf.d/00-hub-apps-include.conf"
SUDOERS_FILE="/etc/sudoers.d/hub-nginx"
HUB_USER="${SUDO_USER:-jefer}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Execute com sudo: sudo bash $0"
  exit 1
fi

mkdir -p "$HUB_NGINX_DIR"
chown -R "$HUB_USER":docker "$HUB_NGINX_DIR" 2>/dev/null || chown -R "$HUB_USER":"$HUB_USER" "$HUB_NGINX_DIR"
chmod 775 "$HUB_NGINX_DIR"

cat > "$INCLUDE_FILE" <<EOF
# Gerado por enable-hub-nginx.sh — inclui confs escritas pelo Central Apps Hub
include /hub-apps/nginx/conf.d/*.conf;
EOF

cat > "$SUDOERS_FILE" <<EOF
# Central Apps Hub — reload nginx sem senha
$HUB_USER ALL=(root) NOPASSWD: /usr/sbin/nginx, /bin/systemctl reload nginx, /usr/sbin/service nginx reload
EOF
chmod 440 "$SUDOERS_FILE"
visudo -cf "$SUDOERS_FILE"

if nginx -t; then
  nginx -s reload 2>/dev/null || systemctl reload nginx 2>/dev/null || true
  echo "OK: Hub pode gravar em $HUB_NGINX_DIR e recarregar o Nginx."
else
  echo "nginx -t falhou — revise as confs existentes."
  exit 1
fi
