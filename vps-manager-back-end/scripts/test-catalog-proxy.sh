#!/bin/bash
set -e
echo "=== Portainer asset paths ==="
curl -s http://127.0.0.1:8081/portainer/ | grep -oE 'src="[^"]+"|href="[^"]+"' | head -n 15

echo ""
echo "=== HTTP codes via Apache ==="
for p in /api/status /locales/pt-BR/translation.json /portainer/api/status /portainer/locales/pt-BR/translation.json /login; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8081$p")
  echo "$p -> $code"
done

echo ""
echo "=== Trailing slash ==="
for p in /portainer /portainer/ /pgadmin /pgadmin/; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8081$p")
  echo "$p -> $code"
done
echo ""
echo "=== Public URLs ==="
for p in https://central-apps-hub.com.br/portainer/ https://central-apps-hub.com.br/pgadmin/login; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -k --max-time 10 "$p")
  echo "$p -> $code"
done
