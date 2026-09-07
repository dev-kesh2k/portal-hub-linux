#!/usr/bin/env bash
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3001}"
pid_file="$BACKEND_DIR/backend.pid"
log_file="$BACKEND_DIR/backend.log"

if [[ -s "$pid_file" ]]; then
  kill "$(cat "$pid_file")" 2>/dev/null || true
  rm -f "$pid_file"
fi
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
fi
sleep 1

cd "$BACKEND_DIR"
echo "Build produção..."
npm run build

setsid env PATH="/usr/bin:/usr/local/bin:/bin:$PATH" node dist/index.js </dev/null >"$log_file" 2>&1 &
echo $! >"$pid_file"

ready=0
for i in $(seq 1 40); do
  if curl -sf --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" -eq 1 ]]; then
  echo "Backend reiniciado (node dist): http://127.0.0.1:${PORT}/health"
else
  echo "Backend falhou ao responder /health" >&2
  tail -n 40 "$log_file" || true
  exit 1
fi
