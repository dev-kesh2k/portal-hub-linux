#!/bin/bash
set -euo pipefail
echo "=== cloudflared container ==="
docker ps --filter name=cloudflared --format 'name={{.Names}} status={{.Status}} ports={{.Ports}}'
echo
echo "=== network / extra hosts ==="
docker inspect cloudflared --format 'NetworkMode={{.HostConfig.NetworkMode}} ExtraHosts={{json .HostConfig.ExtraHosts}}'
echo
echo "=== networks ==="
docker inspect cloudflared --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{"\n"}}{{end}}'
echo
echo "=== cmd (token redacted) ==="
docker inspect cloudflared --format '{{json .Args}}' | sed -E 's/"eyJ[^"]+"/"[REDACTED]"/g'
echo
echo "=== recent logs ==="
docker logs cloudflared --tail 40 2>&1 | sed -E 's/eyJ[A-Za-z0-9._-]+/[REDACTED]/g'
echo
echo "=== from cloudflared container ==="
docker exec cloudflared wget -q -S -O /dev/null http://127.0.0.1:5173/ 2>&1 | head -n 20 || true
docker exec cloudflared wget -q -S -O /dev/null http://127.0.0.1:8081/ 2>&1 | head -n 20 || true
docker exec cloudflared wget -q -S -O /dev/null http://host.docker.internal:8081/ 2>&1 | head -n 20 || true
