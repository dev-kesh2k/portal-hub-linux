import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { adminDatabaseConfig, DATABASE_NAME, getPool } from './pool';
import {
  loadServers,
  loadUsers,
  loadWebsites,
  replaceServers,
  replaceUsers,
  replaceWebsites,
  upsertSetting,
} from './store';
import { ServerNode, UserAccount, WebsiteBookmark } from '../types';

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');

const HUB_SETTINGS: Record<string, string> = {
  project_name: 'Central Apps Hub',
  project_slug: 'central-apps-hub',
  environment: 'local',
  apache_path: '/hub-apps/apache/central-apps-hub',
  servicos_path: '/hub-apps/servicos/central-apps-hub',
  public_url: 'https://central-apps-hub.com.br/central-apps-hub/',
  public_origin: 'https://central-apps-hub.com.br',
};

function safeDbName(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Nome de banco inválido: ${name}`);
  }
  return name;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDbError(err: unknown): boolean {
  const code = String((err as { code?: string })?.code || '');
  const message = String((err as { message?: string })?.message || err).toLowerCase();
  return (
    code === '57P03' ||
    code === '57P04' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    message.includes('starting up') ||
    message.includes('shutting down') ||
    message.includes('connection refused') ||
    message.includes('timeout expired') ||
    message.includes('server login timeout')
  );
}

async function waitForPostgres(): Promise<void> {
  const attempts = Math.max(1, parseInt(process.env.DATABASE_WAIT_ATTEMPTS || '30', 10));
  const delayMs = Math.max(200, parseInt(process.env.DATABASE_WAIT_MS || '1000', 10));
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const admin = new Pool({
      ...adminDatabaseConfig(),
      max: 1,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 3000,
    });
    try {
      await admin.query('SELECT 1');
      if (attempt > 1) {
        console.log(`PostgreSQL: pronto após ${attempt} tentativa(s)`);
      }
      return;
    } catch (err) {
      lastError = err;
      const code = String((err as { code?: string })?.code || '');
      if (code === '28P01' || code === '28000') {
        throw err;
      }
      if (!isRetryableDbError(err) && attempt > 3) {
        throw err;
      }
      const message = (err as { message?: string })?.message || String(err);
      console.log(`PostgreSQL: aguardando inicialização (${attempt}/${attempts}): ${message}`);
      await sleep(delayMs);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }

  const detail = (lastError as { message?: string })?.message || String(lastError);
  throw new Error(
    `PostgreSQL não ficou pronto a tempo (${detail}). Confirme se o container/serviço está no ar na porta ${process.env.DATABASE_PORT || '5432'}.`
  );
}

async function ensureDatabaseExists(): Promise<void> {
  const admin = new Pool(adminDatabaseConfig());
  try {
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE_NAME]);
    if ((found.rowCount || 0) === 0) {
      await admin.query(`CREATE DATABASE ${safeDbName(DATABASE_NAME)}`);
      console.log(`PostgreSQL: banco ${DATABASE_NAME} criado`);
    }
  } finally {
    await admin.end();
  }
}

async function applySchema(): Promise<void> {
  const candidates = [
    path.resolve(__dirname, 'schema.sql'),
    path.resolve(__dirname, '..', '..', 'src', 'db', 'schema.sql'),
  ];
  const schemaPath = candidates.find((file) => fs.existsSync(file));
  if (!schemaPath) {
    throw new Error('schema.sql do PostgreSQL não encontrado');
  }
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await getPool().query(sql);
}

function readJsonFile<T>(fileName: string): T | null {
  const file = path.join(DATA_DIR, fileName);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`Falha ao ler ${fileName}:`, err);
    return null;
  }
}

async function migrateJsonIfEmpty(): Promise<void> {
  const users = await loadUsers();
  if (users.length === 0) {
    const fromFile = readJsonFile<UserAccount[]>('users.json');
    if (Array.isArray(fromFile) && fromFile.length > 0) {
      await replaceUsers(fromFile);
      console.log(`PostgreSQL: ${fromFile.length} usuário(s) importado(s) de users.json`);
    }
  }

  const storedServers = await loadServers();
  if (storedServers.servers.length === 0) {
    const fromFile = readJsonFile<{ activeServerId?: string; servers?: ServerNode[] }>('servers.json');
    if (Array.isArray(fromFile?.servers) && fromFile.servers.length > 0) {
      await replaceServers(fromFile.activeServerId || fromFile.servers[0].id, fromFile.servers);
      console.log(`PostgreSQL: ${fromFile.servers.length} servidor(es) importado(s) de servers.json`);
    }
  }

  const websites = await loadWebsites();
  if (websites.length === 0) {
    const fromFile = readJsonFile<{ websites?: WebsiteBookmark[] } | WebsiteBookmark[]>('websites.json');
    const items = Array.isArray(fromFile) ? fromFile : fromFile?.websites;
    if (Array.isArray(items) && items.length > 0) {
      await replaceWebsites(items);
      console.log(`PostgreSQL: ${items.length} website(s) importado(s) de websites.json`);
    }
  }
}

async function seedHubSettings(): Promise<void> {
  for (const [key, value] of Object.entries(HUB_SETTINGS)) {
    const existing = await getPool().query('SELECT value FROM hub_settings WHERE key = $1', [key]);
    const current = existing.rows[0]?.value as string | undefined;
    const shouldReplace =
      (existing.rowCount || 0) === 0 ||
      ((key === 'public_url' || key === 'public_origin') &&
        (!current || current.includes('127.0.0.1') || current.includes('localhost')));
    if (shouldReplace) {
      await upsertSetting(key, value);
    }
  }
}

export async function initDatabase(): Promise<void> {
  await waitForPostgres();
  await ensureDatabaseExists();
  await applySchema();
  await migrateJsonIfEmpty();
  await seedHubSettings();
  const cfg = await getPool().query('SELECT current_database() AS name');
  console.log(`PostgreSQL: conectado em ${cfg.rows[0].name}`);
}
