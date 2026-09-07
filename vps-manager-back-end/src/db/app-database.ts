import { Pool } from 'pg';
import { adminDatabaseConfig } from './pool';

const RESERVED = new Set(['postgres', 'template0', 'template1', 'central_apps_hub']);

export function appDatabaseName(slug: string): string {
  let name = String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (!name || !/^[a-z]/.test(name)) name = `app_${name || 'backend'}`;
  if (RESERVED.has(name)) name = `app_${name}`;
  return name;
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Nome de banco inválido: ${name}`);
  }
  return name;
}

function hubDbTarget(): { host: string; port: string; user: string; password: string } {
  return {
    host: process.env.HUB_APP_DB_HOST || process.env.APACHE_BACKEND_HOST || '172.17.0.1',
    port: process.env.DATABASE_PORT || '5433',
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
  };
}

export function hubDatabaseUrlForApp(slug: string): {
  name: string;
  user: string;
  password: string;
  url: string;
} {
  const name = appDatabaseName(slug);
  const { host, port, user, password } = hubDbTarget();
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return {
    name,
    user,
    password,
    url: `postgresql://${auth}@${host}:${port}/${name}?schema=public&connection_limit=10`,
  };
}

async function withAdmin<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({
    ...adminDatabaseConfig(),
    max: 1,
    connectionTimeoutMillis: 8000,
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function ensureAppDatabase(slug: string): Promise<string> {
  const name = appDatabaseName(slug);
  await withAdmin(async (admin) => {
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if ((found.rowCount || 0) > 0) return;
    await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
    console.log(`PostgreSQL: banco ${name} criado para o app ${slug}`);
  });
  return name;
}

export async function dropAppDatabase(slug: string): Promise<void> {
  const name = appDatabaseName(slug);
  if (RESERVED.has(name)) return;
  await withAdmin(async (admin) => {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name]
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
  });
}
