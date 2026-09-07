#!/usr/bin/env python3
"""Reconstrói o ingress do túnel Cloudflare sem rota /central-apps-hub."""
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENV = ROOT / '.env'
if ENV.is_file():
    for line in ENV.read_text(encoding='utf-8', errors='replace').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

account = os.environ.get('CF_ACCOUNT_ID')
tunnel = os.environ.get('CF_TUNNEL_ID')
token = os.environ.get('CF_API_TOKEN')
origin = os.environ.get('CF_ORIGIN_SERVICE', 'http://127.0.0.1:8081')
host = os.environ.get('CF_HOST', 'central-apps-hub.com.br')
reserved = {'api', 'health', 'ws', 'central-apps-hub', 'www'}

if not (account and tunnel and token):
    print('CF_API_TOKEN, CF_ACCOUNT_ID e CF_TUNNEL_ID são obrigatórios.', file=sys.stderr)
    sys.exit(1)

url = f'https://api.cloudflare.com/client/v4/accounts/{account}/cfd_tunnel/{tunnel}/configurations'
headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
req = urllib.request.Request(url, headers=headers)
with urllib.request.urlopen(req) as res:
    body = json.load(res)
config = (body.get('result') or {}).get('config') or {}
current = list(config.get('ingress') or [])
paths = []
seen = set()
for rule in current:
    if rule.get('hostname') != host:
        continue
    path = str(rule.get('path') or '').rstrip('*').strip('/')
    if not path or path in reserved:
        continue
    key = f'/{path}'
    if key in seen:
        continue
    seen.add(key)
    paths.append({'hostname': host, 'path': key, 'service': origin})
ingress = paths + [{'hostname': host, 'service': origin}, {'service': 'http_status:404'}]
config['ingress'] = ingress
put = urllib.request.Request(
    url,
    data=json.dumps({'config': config}).encode(),
    method='PUT',
    headers=headers,
)
with urllib.request.urlopen(put) as res:
    json.load(res)
print('Cloudflare: túnel sincronizado')
for rule in ingress:
    if rule.get('path'):
        print(f"  path {rule['path']} -> {rule['service']}")
    elif rule.get('hostname'):
        print(f"  host {rule['hostname']} -> {rule['service']}")
