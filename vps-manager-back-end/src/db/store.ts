import { getPool } from './pool';
import { HubApplication, InstallJob, ScreenPermission, ServerNode, UserAccount, WebsiteBookmark } from '../types';

let writeChain = Promise.resolve();

export function enqueueWrite(task: () => Promise<void>): void {
  writeChain = writeChain.then(task).catch((err) => {
    console.error('Falha ao gravar no PostgreSQL:', err);
  });
}

export async function flushWrites(): Promise<void> {
  await writeChain;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function loadUsers(): Promise<UserAccount[]> {
  const pool = getPool();
  const users = await pool.query(
    `SELECT id, username, password_hash, role, created_at
     FROM users
     ORDER BY created_at ASC`
  );
  if (users.rowCount === 0) return [];

  const perms = await pool.query(
    `SELECT user_id, screen, level FROM user_permissions ORDER BY screen`
  );
  const byUser = new Map<string, ScreenPermission[]>();
  for (const row of perms.rows) {
    const list = byUser.get(row.user_id) || [];
    list.push({ screen: row.screen, level: row.level });
    byUser.set(row.user_id, list);
  }

  return users.rows.map((row) => ({
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: asNumber(row.created_at),
    permissions: byUser.get(row.id) || [],
  }));
}

export async function replaceUsers(list: UserAccount[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_permissions');
    await client.query('DELETE FROM users');
    for (const user of list) {
      await client.query(
        `INSERT INTO users (id, username, password_hash, role, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.id, user.username, user.passwordHash, user.role, user.createdAt]
      );
      for (const perm of user.permissions) {
        await client.query(
          `INSERT INTO user_permissions (user_id, screen, level) VALUES ($1, $2, $3)`,
          [user.id, perm.screen, perm.level]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function loadServers(): Promise<{ activeServerId: string; servers: ServerNode[] }> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, name, type, is_default, status, description, wsl_distro, host, port,
            username, auth_type, password, private_key, created_at, last_connected_at,
            last_error, distro, kernel, uptime
     FROM servers
     ORDER BY created_at ASC`
  );
  const active = await getSetting('active_server_id');
  const servers: ServerNode[] = result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    isDefault: !!row.is_default,
    status: row.status || undefined,
    description: row.description || undefined,
    wslDistro: row.wsl_distro || undefined,
    host: row.host || undefined,
    port: row.port == null ? undefined : Number(row.port),
    username: row.username || undefined,
    authType: row.auth_type || undefined,
    password: row.password || undefined,
    privateKey: row.private_key || undefined,
    createdAt: asNumber(row.created_at),
    lastConnectedAt: row.last_connected_at == null ? undefined : asNumber(row.last_connected_at),
    lastError: row.last_error || undefined,
    distro: row.distro || undefined,
    kernel: row.kernel || undefined,
    uptime: row.uptime || undefined,
  }));
  return {
    servers,
    activeServerId: active || servers[0]?.id || 'wsl-local',
  };
}

export async function replaceServers(activeServerId: string, servers: ServerNode[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM servers');
    for (const server of servers) {
      await client.query(
        `INSERT INTO servers (
           id, name, type, is_default, status, description, wsl_distro, host, port,
           username, auth_type, password, private_key, created_at, last_connected_at,
           last_error, distro, kernel, uptime
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
         )`,
        [
          server.id,
          server.name,
          server.type,
          !!server.isDefault,
          server.status || null,
          server.description || null,
          server.wslDistro || null,
          server.host || null,
          server.port ?? null,
          server.username || null,
          server.authType || null,
          server.password || null,
          server.privateKey || null,
          server.createdAt,
          server.lastConnectedAt ?? null,
          server.lastError || null,
          server.distro || null,
          server.kernel || null,
          server.uptime || null,
        ]
      );
    }
    await client.query(
      `INSERT INTO hub_settings (key, value, updated_at)
       VALUES ('active_server_id', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [activeServerId, Date.now()]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function loadWebsites(): Promise<WebsiteBookmark[]> {
  const result = await getPool().query(
    `SELECT id, name, url, description, created_at, updated_at
     FROM websites
     ORDER BY name ASC`
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    description: row.description || undefined,
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
  }));
}

export async function replaceWebsites(items: WebsiteBookmark[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM websites');
    for (const item of items) {
      await client.query(
        `INSERT INTO websites (id, name, url, description, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [item.id, item.name, item.url, item.description || null, item.createdAt, item.updatedAt]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function loadApplications(): Promise<HubApplication[]> {
  const result = await getPool().query(
    `SELECT id, name, slug, description, has_frontend, has_backend, frontend_path, backend_path,
            backend_port, public_port, frontend_url, backend_url, public_url, nginx_enabled,
            nginx_message, cloudflare_enabled, cloudflare_message, status, last_error,
            replicas, memory_limit_mb, cpu_limit,
            auto_scale_enabled, auto_scale_min, auto_scale_max,
            auto_scale_cpu_up, auto_scale_mem_up, auto_scale_cpu_down, auto_scale_mem_down,
            last_scale_at, created_at, updated_at
     FROM hub_applications
     ORDER BY created_at DESC`
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description || undefined,
    hasFrontend: !!row.has_frontend,
    hasBackend: !!row.has_backend,
    frontendPath: row.frontend_path || undefined,
    backendPath: row.backend_path || undefined,
    backendPort: row.backend_port == null ? undefined : Number(row.backend_port),
    publicPort: row.public_port == null ? undefined : Number(row.public_port),
    frontendUrl: row.frontend_url || undefined,
    backendUrl: row.backend_url || undefined,
    publicUrl: row.public_url || undefined,
    nginxEnabled: !!row.nginx_enabled,
    nginxMessage: row.nginx_message || undefined,
    cloudflareEnabled: !!row.cloudflare_enabled,
    cloudflareMessage: row.cloudflare_message || undefined,
    status: row.status,
    lastError: row.last_error || undefined,
    replicas: row.replicas == null ? 1 : Math.max(1, Number(row.replicas) || 1),
    memoryLimitMb: row.memory_limit_mb == null ? 512 : Number(row.memory_limit_mb) || 512,
    cpuLimit: row.cpu_limit == null ? undefined : Number(row.cpu_limit),
    autoScaleEnabled: !!row.auto_scale_enabled,
    autoScaleMin: row.auto_scale_min == null ? 1 : Number(row.auto_scale_min) || 1,
    autoScaleMax: row.auto_scale_max == null ? 3 : Number(row.auto_scale_max) || 3,
    autoScaleCpuUp: row.auto_scale_cpu_up == null ? 70 : Number(row.auto_scale_cpu_up) || 70,
    autoScaleMemUp: row.auto_scale_mem_up == null ? 80 : Number(row.auto_scale_mem_up) || 80,
    autoScaleCpuDown: row.auto_scale_cpu_down == null ? 25 : Number(row.auto_scale_cpu_down) || 25,
    autoScaleMemDown: row.auto_scale_mem_down == null ? 40 : Number(row.auto_scale_mem_down) || 40,
    lastScaleAt: row.last_scale_at == null ? undefined : asNumber(row.last_scale_at),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
  }));
}

export async function replaceApplications(items: HubApplication[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM hub_applications');
    for (const item of items) {
      await client.query(
        `INSERT INTO hub_applications (
           id, name, slug, description, has_frontend, has_backend, frontend_path, backend_path,
           backend_port, public_port, frontend_url, backend_url, public_url, nginx_enabled,
           nginx_message, cloudflare_enabled, cloudflare_message, status, last_error,
           replicas, memory_limit_mb, cpu_limit,
           auto_scale_enabled, auto_scale_min, auto_scale_max,
           auto_scale_cpu_up, auto_scale_mem_up, auto_scale_cpu_down, auto_scale_mem_down,
           last_scale_at, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
           $23,$24,$25,$26,$27,$28,$29,$30,$31,$32
         )`,
        [
          item.id,
          item.name,
          item.slug,
          item.description || null,
          !!item.hasFrontend,
          !!item.hasBackend,
          item.frontendPath || null,
          item.backendPath || null,
          item.backendPort ?? null,
          item.publicPort ?? null,
          item.frontendUrl || null,
          item.backendUrl || null,
          item.publicUrl || null,
          !!item.nginxEnabled,
          item.nginxMessage || null,
          !!item.cloudflareEnabled,
          item.cloudflareMessage || null,
          item.status,
          item.lastError || null,
          item.replicas ?? 1,
          item.memoryLimitMb ?? 512,
          item.cpuLimit ?? null,
          !!item.autoScaleEnabled,
          item.autoScaleMin ?? 1,
          item.autoScaleMax ?? 3,
          item.autoScaleCpuUp ?? 70,
          item.autoScaleMemUp ?? 80,
          item.autoScaleCpuDown ?? 25,
          item.autoScaleMemDown ?? 40,
          item.lastScaleAt ?? null,
          item.createdAt,
          item.updatedAt,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getSetting(key: string): Promise<string | undefined> {
  const result = await getPool().query(`SELECT value FROM hub_settings WHERE key = $1`, [key]);
  return result.rows[0]?.value;
}

export async function upsertSetting(key: string, value: string): Promise<void> {
  await getPool().query(
    `INSERT INTO hub_settings (key, value, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, value, Date.now()]
  );
}

export async function loadSettings(): Promise<Record<string, string>> {
  const result = await getPool().query(`SELECT key, value FROM hub_settings ORDER BY key`);
  const out: Record<string, string> = {};
  for (const row of result.rows) out[row.key] = row.value;
  return out;
}

export async function loadInstallJobs(limit = 100): Promise<InstallJob[]> {
  const result = await getPool().query(
    `SELECT job_id, app_id, status, started_at, finished_at, output, error
     FROM install_jobs
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    jobId: row.job_id,
    appId: row.app_id,
    status: row.status,
    startedAt: asNumber(row.started_at),
    finishedAt: row.finished_at == null ? undefined : asNumber(row.finished_at),
    output: row.output || '',
    error: row.error || undefined,
  }));
}

export async function pruneOldInstallJobs(retentionDays = 7): Promise<number> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result = await getPool().query(
    `DELETE FROM install_jobs
     WHERE finished_at IS NOT NULL AND finished_at < $1`,
    [cutoff],
  );
  return result.rowCount ?? 0;
}

export async function upsertInstallJob(job: InstallJob): Promise<void> {
  await getPool().query(
    `INSERT INTO install_jobs (job_id, app_id, status, started_at, finished_at, output, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (job_id) DO UPDATE SET
       status = EXCLUDED.status,
       finished_at = EXCLUDED.finished_at,
       output = EXCLUDED.output,
       error = EXCLUDED.error`,
    [
      job.jobId,
      job.appId,
      job.status,
      job.startedAt,
      job.finishedAt ?? null,
      job.output || '',
      job.error || null,
    ]
  );
}
