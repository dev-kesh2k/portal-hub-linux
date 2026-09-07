#!/usr/bin/env node
/**
 * Ferramentas de diagnóstico Cloudflare para o Central Apps Hub.
 * Uso: node scripts/cloudflare-cli.js <verify|tunnels|full|fix-env>
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const cmd = process.argv[2] || 'verify';
const token = String(process.env.CF_API_TOKEN || '');
const account = process.env.CF_ACCOUNT_ID;
const tunnel = process.env.CF_TUNNEL_ID;

function mask(value) {
  if (!value) return '(vazio)';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length} chars)`;
}

function tokenKind(value) {
  if (!value) return 'vazio';
  if (value.startsWith('cfut_')) return 'cfut (user token — não serve para editar túnel)';
  if (value.length < 30) return 'muito curto para API token';
  return 'api token (formato ok)';
}

async function verify() {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const verify = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers });
  const verifyBody = await verify.json();
  console.log('verify', verify.status, JSON.stringify(verifyBody?.success));
  if (!account || !tunnel) {
    console.log('CF_ACCOUNT_ID ou CF_TUNNEL_ID ausente no .env');
    return;
  }
  const get = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/cfd_tunnel/${tunnel}/configurations`,
    { headers },
  );
  const getBody = await get.json();
  console.log('tunnel get', get.status, getBody?.success, getBody?.errors?.[0]?.message || 'ok');
}

async function tunnels() {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const accountRe = /^[0-9a-f]{32}$/i;
  const accountOk = uuidRe.test(String(account)) || accountRe.test(String(account));
  const tunnelOk = uuidRe.test(String(tunnel));

  console.log('CF_ACCOUNT_ID', mask(account), accountOk ? 'OK' : 'INVALID');
  console.log('CF_TUNNEL_ID', mask(tunnel), tunnelOk ? 'OK' : 'INVALID');
  if (String(tunnel).startsWith('cfut_') || String(tunnel).startsWith('eyJ')) {
    console.log('CF_TUNNEL_ID parece ser token de execução. Use o UUID do túnel em CF_TUNNEL_ID.');
  }

  const list = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/cfd_tunnel`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await list.json();
  console.log('list tunnels', list.status, body?.success ? 'ok' : 'fail');
  for (const t of body.result || []) {
    console.log(`- ${t.name} | id=${t.id} | status=${t.status}${t.id === tunnel ? ' <-- atual' : ''}`);
  }
}

async function full() {
  console.log('CF_API_TOKEN tipo:', tokenKind(token), `(${token.length} chars)`);
  await verify();
  await tunnels();
}

function fixEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  let runToken = '';
  try {
    runToken = execSync("docker inspect cloudflared --format '{{index .Config.Cmd 4}}'", {
      encoding: 'utf8',
    }).trim();
    if (runToken === '<no value>') runToken = '';
  } catch {
    /* container pode estar parado */
  }

  let text = fs.readFileSync(envPath, 'utf8');
  const set = (key, value) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    const line = `${key}=${value}`;
    text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  };

  if (tunnel && /^[0-9a-f-]{36}$/i.test(String(tunnel))) {
    set('CF_TUNNEL_ID', tunnel);
  }
  if (runToken) set('CF_TUNNEL_TOKEN', runToken);

  fs.writeFileSync(envPath, text.endsWith('\n') ? text : `${text}\n`);
  console.log('CF_TUNNEL_ID/CF_TUNNEL_TOKEN atualizados no .env');
}

async function main() {
  if (cmd === 'verify') return verify();
  if (cmd === 'tunnels') return tunnels();
  if (cmd === 'full') return full();
  if (cmd === 'fix-env') return fixEnv();
  console.log('Comandos: verify | tunnels | full | fix-env');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
