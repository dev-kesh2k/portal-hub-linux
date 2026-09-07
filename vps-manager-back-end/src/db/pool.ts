import { execFileSync } from 'child_process';
import { Pool, PoolConfig } from 'pg';

export const DATABASE_NAME = process.env.DATABASE_NAME || 'central_apps_hub';

function resolveDatabaseHost(host: string): string {
  if (process.platform !== 'win32') return host;
  if (host !== '127.0.0.1' && host !== 'localhost') return host;
  try {
    const raw = execFileSync('wsl.exe', ['-d', process.env.WSL_DISTRO || 'Ubuntu', '--', 'hostname', '-I'], {
      windowsHide: true,
      timeout: 5000,
    });
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    const text =
      buf.length >= 2 && buf[1] === 0 ? buf.toString('utf16le') : buf.toString('utf8');
    const ip = text.replace(/\u0000/g, '').trim().split(/\s+/)[0];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  } catch {
    /* keep configured host */
  }
  return host;
}

export function databaseConfig(): PoolConfig {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }
  return {
    host: resolveDatabaseHost(process.env.DATABASE_HOST || '127.0.0.1'),
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: DATABASE_NAME,
  };
}

export function adminDatabaseConfig(): PoolConfig {
  const cfg = databaseConfig();
  if (cfg.connectionString) {
    const url = new URL(cfg.connectionString);
    url.pathname = '/postgres';
    return { connectionString: url.toString() };
  }
  return { ...cfg, database: 'postgres' };
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      ...databaseConfig(),
      max: parseInt(process.env.DATABASE_POOL_MAX || '4', 10),
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    });
    pool.on('error', (err) => {
      console.error('PostgreSQL pool error:', err.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}

export async function databaseHealth(): Promise<{
  status: 'ok' | 'error';
  name: string;
  host?: string;
  error?: string;
}> {
  try {
    const cfg = databaseConfig();
    const result = await Promise.race([
      getPool().query('SELECT current_database() AS name'),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('database health timeout')), 3000);
      }),
    ]);
    return {
      status: 'ok',
      name: result.rows[0]?.name || DATABASE_NAME,
      host: cfg.host || (cfg.connectionString ? new URL(cfg.connectionString).hostname : undefined),
    };
  } catch (err: any) {
    return { status: 'error', name: DATABASE_NAME, error: err.message || String(err) };
  }
}
