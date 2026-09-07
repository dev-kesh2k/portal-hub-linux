import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
];

for (const envPath of candidates) {
  if (!fs.existsSync(envPath)) continue;
  dotenv.config({ path: envPath, override: true });
  break;
}

function stripWin(value: string | undefined): string {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

for (const key of ['AUTH_USERNAME', 'AUTH_PASSWORD', 'WSL_DISTRO', 'PORT', 'DATABASE_HOST', 'DATABASE_PORT']) {
  if (process.env[key]) process.env[key] = stripWin(process.env[key]);
}

if (process.platform !== 'win32') {
  const linuxBins = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const rest = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter((entry) => {
      if (!entry) return false;
      if (/^\/mnt\/[a-z]\//i.test(entry)) return false;
      if (entry.includes('Program Files/nodejs')) return false;
      return true;
    })
    .join(path.delimiter);
  process.env.PATH = rest ? `${linuxBins}${path.delimiter}${rest}` : linuxBins;
}
