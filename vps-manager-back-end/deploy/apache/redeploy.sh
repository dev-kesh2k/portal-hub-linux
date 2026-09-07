#!/bin/bash
set -e
PROJECT="${PROJECT:-central-apps-hub}"
if [[ -z "${WINHOST:-}" || "${WINHOST}" == "host-gateway" ]]; then
  WINHOST="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4; exit}' | cut -d/ -f1 || true)"
fi
if [[ -z "${WINHOST:-}" ]]; then
  WINHOST="$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}'; true)"
fi
WINHOST="${WINHOST:-host-gateway}"
echo "WINHOST=${WINHOST} PROJECT=${PROJECT}"
export WINHOST
cd /opt/apache
docker compose up -d --force-recreate
sleep 2
echo -n "root:"
curl -s --max-time 5 -o /dev/null -w '%{http_code} ' "http://127.0.0.1:8081/"
echo -n "app:"
curl -s --max-time 5 -o /dev/null -w '%{http_code} ' "http://127.0.0.1:8081/${PROJECT}/"
echo -n "login:"
curl -s --max-time 5 -o /dev/null -w '%{http_code} ' "http://127.0.0.1:8081/${PROJECT}/login"
echo -n "health:"
curl -s --max-time 8 -o /dev/null -w '%{http_code} ' http://127.0.0.1:8081/health
echo
docker logs apache --tail 20
