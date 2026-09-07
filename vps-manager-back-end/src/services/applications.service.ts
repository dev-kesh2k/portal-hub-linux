import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HubApplication, PortAllocation } from '../types';
import { enqueueWrite, loadApplications, replaceApplications } from '../db/store';
import { appDatabaseName, dropAppDatabase, ensureAppDatabase, hubDatabaseUrlForApp } from '../db/app-database';
import { serverManagerService } from './server-manager.service';
import { cloudflareService, type CloudflarePublishResult } from './cloudflare.service';
import { appsService } from './apps.service';

const BACKEND_PORT_START = 3100;
const BACKEND_PORT_END = 3199;
const PUBLIC_PORT_START = 8100;
const PUBLIC_PORT_END = 8199;

const RESERVED_PORTS = new Set([
  22, 80, 443, 3001, 3002, 3306, 5050, 5173, 5432, 5433, 6379, 8080, 8081, 9000, 9443, 20241,
]);

const APACHE_ROOT = '/hub-apps/apache';
const SERVICOS_ROOT = '/hub-apps/servicos';
const APACHE_CONF = '/opt/apache/hub.conf';
const BEGIN_MARK = '# BEGIN HUB-APLICACOES';
const END_MARK = '# END HUB-APLICACOES';
const RESERVED_SLUGS = new Set(['api', 'health', 'ws', 'central-apps-hub', 'www']);
const APACHE_BACKEND_HOST = process.env.APACHE_BACKEND_HOST || '172.17.0.1';

function clampReplicas(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(1, n));
}

function clampMemoryMb(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 512;
  return Math.min(4096, Math.max(128, n));
}

function clampCpuLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(4, Math.max(0.1, Math.round(n * 100) / 100));
}

function clampPercent(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(95, Math.max(5, n));
}

function needsScalableLayout(app: {
  replicas?: number;
  autoScaleEnabled?: boolean;
  autoScaleMax?: number;
}): boolean {
  return (
    !!app.autoScaleEnabled ||
    clampReplicas(app.replicas ?? 1) > 1 ||
    clampReplicas(app.autoScaleMax ?? 1) > 1
  );
}

function resourceLimitLines(memoryMb: number, cpuLimit?: number, reserveMb = 64): string[] {
  const lines = [
    `    mem_limit: ${memoryMb}m`,
    '    deploy:',
    '      resources:',
    '        limits:',
    `          memory: ${memoryMb}M`,
  ];
  if (cpuLimit) lines.push(`          cpus: '${cpuLimit.toFixed(2)}'`);
  lines.push('        reservations:', `          memory: ${reserveMb}M`);
  return lines;
}

function publicOrigin(): string {
  return String(process.env.PUBLIC_ORIGIN || 'https://central-apps-hub.com.br').replace(/\/$/, '');
}

function urlsFor(
  app: { slug: string; hasFrontend?: boolean; hasBackend?: boolean },
  routeSlug = app.slug
): {
  frontendUrl?: string;
  backendUrl?: string;
  publicUrl: string;
} {
  const origin = publicOrigin();
  const publicUrl = `${origin}/${routeSlug}/`;
  return {
    frontendUrl: app.hasFrontend ? publicUrl : undefined,
    backendUrl: app.hasBackend ? `${origin}/${routeSlug}/api/` : undefined,
    publicUrl,
  };
}

function genId(): string {
  return randomBytes(8).toString('hex');
}

function slugify(name: string): string {
  const slug = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'app';
}

export function toWslPath(winPath: string): string {
  const normalized = winPath.replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (match) return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
  return normalized;
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeTemp(prefix: string, contents: string, ext = '.sh'): string {
  const file = path.join(os.tmpdir(), `${prefix}-${randomBytes(6).toString('hex')}${ext}`);
  fs.writeFileSync(file, contents.replace(/\r\n/g, '\n'), 'utf8');
  return file;
}

type BackendPlan = {
  hasDockerfile: boolean;
  /** Multi-stage target preferido (ex.: runner). Vazio = estágio final do Dockerfile. */
  dockerfileTarget: string;
  hasPrisma: boolean;
  hasPackage: boolean;
  hasWorker: boolean;
  workerCommand: string;
  needsDatabase: boolean;
  needsRedis: boolean;
  convertedPrisma: boolean;
  innerPort: number;
};

export class ApplicationsService {
  private items: HubApplication[] = [];
  private jobs = new Set<string>();

  async reload(): Promise<void> {
    try {
      this.items = await loadApplications();
      let changed = false;
      for (const app of this.items) {
        if (this.assignPublicUrls(app)) changed = true;
        if (this.normalizeStatusMessages(app)) changed = true;
        if (app.status === 'deploying' && !this.jobs.has(app.id)) {
          app.status = 'error';
          app.lastError = 'Publicação interrompida. Publique de novo.';
          changed = true;
        }
      }
      if (changed) this.persist();
    } catch (err) {
      console.error('Falha ao carregar aplicações:', err);
      this.items = [];
    }
  }

  /** Mantém só o status curto no card (sem detalhes de deploy). */
  private normalizeStatusMessages(app: HubApplication): boolean {
    let changed = false;
    if (app.nginxEnabled && app.publicPort) {
      const short = `Nginx escutando na porta ${app.publicPort}`;
      if (app.nginxMessage !== short) {
        app.nginxMessage = short;
        changed = true;
      }
    }
    if (app.cloudflareEnabled) {
      if (app.cloudflareMessage !== 'Cloudflare atualizado') {
        app.cloudflareMessage = 'Cloudflare atualizado';
        changed = true;
      }
    }
    return changed;
  }

  private runJob(app: HubApplication, work: () => Promise<void>): void {
    if (this.jobs.has(app.id)) return;
    this.jobs.add(app.id);
    void work()
      .then(() => {
        if (app.status === 'deploying') app.status = 'active';
      })
      .catch((err: any) => {
        app.status = 'error';
        app.lastError = err?.message || String(err);
      })
      .finally(() => {
        this.jobs.delete(app.id);
        app.updatedAt = Date.now();
        this.persist();
      });
  }

  private assignPublicUrls(app: HubApplication): boolean {
    const next = urlsFor(app, this.publicRouteSlug(app));
    const changed =
      app.frontendUrl !== next.frontendUrl ||
      app.backendUrl !== next.backendUrl ||
      app.publicUrl !== next.publicUrl;
    app.frontendUrl = next.frontendUrl;
    app.backendUrl = next.backendUrl;
    app.publicUrl = next.publicUrl;
    return changed;
  }

  /** Slug público no Apache/URL (ex.: backend `foo-api` usa frontend em `/foo/`). */
  private publicRouteSlug(app: HubApplication): string {
    if (app.hasFrontend) return app.slug;
    if (app.slug.endsWith('-api')) {
      const sibling = app.slug.slice(0, -4);
      if (sibling && this.items.some((a) => a.slug === sibling && a.hasFrontend)) {
        return sibling;
      }
    }
    return app.slug;
  }

  private tunnelSlugs(): string[] {
    return this.items.map((app) => app.slug);
  }

  private async syncCloudflareRoutes(): Promise<CloudflarePublishResult> {
    const installed = await appsService.listInstalled();
    return cloudflareService.publishRoutes(this.tunnelSlugs(), appsService.getInstalledTunnelPaths(installed));
  }

  list(): HubApplication[] {
    return [...this.items]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((app) => ({
        ...app,
        databaseName: app.hasBackend ? appDatabaseName(app.slug) : undefined,
      }));
  }

  getById(id: string): HubApplication | undefined {
    return this.items.find((a) => a.id === id);
  }

  private persist(): void {
    enqueueWrite(() => replaceApplications(this.items));
  }

  private usedPorts(): Set<number> {
    const used = new Set(RESERVED_PORTS);
    for (const app of this.items) {
      if (app.backendPort) used.add(app.backendPort);
      if (app.publicPort) used.add(app.publicPort);
    }
    return used;
  }

  allocatePort(kind: 'backend' | 'public', extraBusy: Set<number> = new Set()): number {
    const used = this.usedPorts();
    Array.from(extraBusy).forEach((p) => used.add(p));
    const start = kind === 'backend' ? BACKEND_PORT_START : PUBLIC_PORT_START;
    const end = kind === 'backend' ? BACKEND_PORT_END : PUBLIC_PORT_END;
    for (let port = start; port <= end; port++) {
      if (!used.has(port)) return port;
    }
    throw new Error(`Não há portas livres no intervalo ${start}-${end}`);
  }

  async listPorts(): Promise<PortAllocation[]> {
    const listening = await this.scanListeningPorts();
    const rows: PortAllocation[] = [];
    const seen = new Set<number>();

    for (const port of Array.from(RESERVED_PORTS).sort((a, b) => a - b)) {
      seen.add(port);
      rows.push({
        port,
        status: listening.has(port) ? 'listening' : 'reserved',
        role: 'system',
        process: listening.get(port),
      });
    }

    for (const app of this.items) {
      if (app.backendPort && !seen.has(app.backendPort)) {
        seen.add(app.backendPort);
        rows.push({
          port: app.backendPort,
          status: listening.has(app.backendPort) ? 'listening' : 'allocated',
          appId: app.id,
          appName: app.name,
          role: 'backend',
          process: listening.get(app.backendPort),
        });
      }
      if (app.publicPort && !seen.has(app.publicPort)) {
        seen.add(app.publicPort);
        rows.push({
          port: app.publicPort,
          status: listening.has(app.publicPort) ? 'listening' : 'allocated',
          appId: app.id,
          appName: app.name,
          role: 'public',
          process: listening.get(app.publicPort),
        });
      }
    }

    return rows.sort((a, b) => a.port - b.port);
  }

  private async scanListeningPorts(): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    try {
      const res = await serverManagerService.executeCommand({
        command: 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || true',
        timeout: 15000,
      });
      for (const line of (res.stdout || '').split('\n')) {
        const portMatch = line.match(/:(\d+)\s/);
        if (!portMatch) continue;
        const port = parseInt(portMatch[1], 10);
        if (!port) continue;
        const proc =
          (line.match(/users:\(\("([^"]+)"/) || line.match(/(\S+)$/) || [])[1] || 'ocupada';
        map.set(port, proc);
      }
    } catch {
      /* ignore */
    }
    return map;
  }

  private resolveCreateSlug(name: string, hasFrontend: boolean, hasBackend: boolean): string {
    const base = slugify(name);
    if (hasFrontend && hasBackend && base.endsWith('-api')) {
      return this.uniqueSlug(base.slice(0, -4));
    }
    return this.uniqueSlug(base);
  }

  private uniqueSlug(base: string): string {
    let slug = RESERVED_SLUGS.has(base) ? `${base}-app` : base;
    let i = 2;
    while (RESERVED_SLUGS.has(slug) || this.items.some((a) => a.slug === slug)) {
      slug = `${base}-${i++}`;
    }
    return slug;
  }

  private async run(
    command: string,
    opts?: { username?: string; password?: string; timeout?: number }
  ) {
    const timeout = opts?.timeout || 120000;

    // Sempre tenta primeiro sem sudo (usuário do Hub + grupo docker deve bastar em /hub-apps).
    const direct = await serverManagerService.executeCommand({
      command,
      username: opts?.username,
      timeout,
    });
    if (direct.success) return direct;

    const password = String(opts?.password || '');
    if (!password) return direct;

    // Senha do AUTH_*.env NÃO é senha do sudo Linux — não tentar elevar com ela.
    const authPass = String(process.env.AUTH_PASSWORD || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r/g, '')
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (authPass && password === authPass) return direct;

    const errText = `${direct.stderr || ''}\n${direct.stdout || ''}`.toLowerCase();
    const needsRoot = /permission denied|eacces|operation not permitted|read-only|not writable|cannot create|access denied/.test(
      errText
    );
    if (!needsRoot) return direct;

    const inner = `export DEBIAN_FRONTEND=noninteractive; ${command}`;
    const cmd = [
      `if [ -x /usr/bin/sudo ]; then`,
      `/usr/bin/sudo -S -p '' -k bash -lc ${shellQuote(inner)};`,
      `else ${command}; fi`,
    ].join(' ');
    return serverManagerService.executeCommandStdin(
      { command: cmd, username: opts.username, timeout },
      `${password}\n`
    );
  }

  private async runScript(
    script: string,
    args: string[],
    opts?: { username?: string; password?: string; timeout?: number }
  ) {
    const file = writeTemp('hub-app', `#!/bin/bash\nset -e\n${script}\n`);
    try {
      const wsl = toWslPath(file);
      return await this.run(`bash ${shellQuote(wsl)} ${args.map(shellQuote).join(' ')}`.trim(), opts);
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  }

  async create(input: {
    name: string;
    description?: string;
    frontendZip?: string;
    backendZip?: string;
    linuxUsername?: string;
    linuxPassword?: string;
    replicas?: number;
    memoryLimitMb?: number;
    cpuLimit?: number;
  }): Promise<HubApplication> {
    const name = String(input.name || '').trim();
    if (name.length < 2) throw new Error('Informe o nome da aplicação');
    if (!input.frontendZip && !input.backendZip) {
      throw new Error('Envie pelo menos um arquivo: frontend ou backend');
    }

    if (!input.frontendZip && input.backendZip) {
      const base = slugify(name);
      const siblingSlug = base.endsWith('-api') ? base.slice(0, -4) : base;
      const existing = this.items.find(
        (a) => a.slug === siblingSlug && a.hasFrontend && !a.hasBackend
      );
      if (existing) {
        return this.addFiles(existing.id, {
          backendZip: input.backendZip,
          linuxUsername: input.linuxUsername,
          linuxPassword: input.linuxPassword,
          replicas: input.replicas,
          memoryLimitMb: input.memoryLimitMb,
          cpuLimit: input.cpuLimit,
        });
      }
    }

    const slug = this.resolveCreateSlug(name, !!input.frontendZip, !!input.backendZip);
    const listening = await this.scanListeningPorts();
    const busy = new Set<number>(Array.from(listening.keys()));
    const publicPort = this.allocatePort('public', busy);
    busy.add(publicPort);
    const backendPort = input.backendZip ? this.allocatePort('backend', busy) : undefined;

    const now = Date.now();
    const app: HubApplication = {
      id: genId(),
      name,
      slug,
      description: input.description?.trim() || undefined,
      hasFrontend: !!input.frontendZip,
      hasBackend: !!input.backendZip,
      frontendPath: input.frontendZip ? `${APACHE_ROOT}/${slug}` : undefined,
      backendPath: input.backendZip ? `${SERVICOS_ROOT}/${slug}` : undefined,
      backendPort,
      publicPort,
      ...urlsFor({ slug, hasFrontend: !!input.frontendZip, hasBackend: !!input.backendZip }),
      nginxEnabled: false,
      cloudflareEnabled: false,
      databaseName: input.backendZip ? appDatabaseName(slug) : undefined,
      replicas: clampReplicas(input.replicas),
      memoryLimitMb: clampMemoryMb(input.memoryLimitMb),
      cpuLimit: clampCpuLimit(input.cpuLimit),
      status: 'deploying',
      createdAt: now,
      updatedAt: now,
    };

    this.items.push(app);
    this.persist();
    this.runJob(app, async () => {
      await this.deploy(app, input);
    });
    return app;
  }

  async addFiles(
    id: string,
    input: {
      frontendZip?: string;
      backendZip?: string;
      linuxUsername?: string;
      linuxPassword?: string;
      replicas?: number;
      memoryLimitMb?: number;
      cpuLimit?: number;
    }
  ): Promise<HubApplication> {
    const app = this.getById(id);
    if (!app) throw new Error('Aplicação não encontrada');
    if (this.jobs.has(app.id) || app.status === 'deploying') {
      throw new Error('Essa aplicação ainda está publicando.');
    }
    if (!input.frontendZip && !input.backendZip) {
      throw new Error('Envie um arquivo de frontend ou backend');
    }

    if (input.replicas !== undefined) app.replicas = clampReplicas(input.replicas);
    if (input.memoryLimitMb !== undefined) app.memoryLimitMb = clampMemoryMb(input.memoryLimitMb);
    if (input.cpuLimit !== undefined) app.cpuLimit = clampCpuLimit(input.cpuLimit);

    if (input.frontendZip) {
      app.hasFrontend = true;
      app.frontendPath = `${APACHE_ROOT}/${app.slug}`;
    }
    if (input.backendZip) {
      app.hasBackend = true;
      app.backendPath = `${SERVICOS_ROOT}/${app.slug}`;
      if (!app.backendPort) {
        const listening = await this.scanListeningPorts();
        app.backendPort = this.allocatePort('backend', new Set(listening.keys()));
      }
      if (!app.replicas) app.replicas = 1;
      if (!app.memoryLimitMb) app.memoryLimitMb = 512;
    }
    if (!app.publicPort) {
      const listening = await this.scanListeningPorts();
      app.publicPort = this.allocatePort('public', new Set(listening.keys()));
    }
    this.assignPublicUrls(app);

    app.status = 'deploying';
    app.lastError = undefined;
    app.updatedAt = Date.now();
    this.persist();
    this.runJob(app, async () => {
      await this.deploy(app, input);
    });
    return app;
  }

  async redeploy(
    id: string,
    opts?: { linuxUsername?: string; linuxPassword?: string }
  ): Promise<HubApplication> {
    const app = this.getById(id);
    if (!app) throw new Error('Aplicação não encontrada');
    if (this.jobs.has(app.id) || app.status === 'deploying') return app;
    app.status = 'deploying';
    app.lastError = undefined;
    app.updatedAt = Date.now();
    this.persist();
    this.runJob(app, async () => {
      if (app.hasFrontend) {
        await this.ensureApacheSpa({ username: opts?.linuxUsername, password: opts?.linuxPassword });
      }
      if (app.hasBackend) {
        await ensureAppDatabase(app.slug);
      }
      if (app.hasBackend && app.backendPort) {
        const listening = await this.scanListeningPorts();
        if (!listening.has(app.backendPort)) {
          await this.startBackend(app, opts?.linuxUsername, opts?.linuxPassword);
        }
      }
      const nginx = await this.configureNginx(app, opts?.linuxUsername, opts?.linuxPassword);
      app.nginxEnabled = nginx.ok;
      app.nginxMessage = nginx.message;
      const cf = await this.syncCloudflareRoutes();
      app.cloudflareEnabled = cf.ok;
      app.cloudflareMessage = cf.message;
    });
    return app;
  }

  async updateScale(
    id: string,
    input: {
      replicas?: number;
      memoryLimitMb?: number;
      cpuLimit?: number | null;
      autoScaleEnabled?: boolean;
      autoScaleMin?: number;
      autoScaleMax?: number;
      autoScaleCpuUp?: number;
      autoScaleMemUp?: number;
      autoScaleCpuDown?: number;
      autoScaleMemDown?: number;
      linuxUsername?: string;
      linuxPassword?: string;
    }
  ): Promise<HubApplication> {
    const app = this.getById(id);
    if (!app) throw new Error('Aplicação não encontrada');
    if (!app.hasBackend) throw new Error('Réplicas e limites só se aplicam a aplicações com backend.');
    if (this.jobs.has(app.id) || app.status === 'deploying') {
      throw new Error('Essa aplicação ainda está publicando.');
    }

    if (input.replicas !== undefined) app.replicas = clampReplicas(input.replicas);
    if (input.memoryLimitMb !== undefined) app.memoryLimitMb = clampMemoryMb(input.memoryLimitMb);
    if (input.cpuLimit !== undefined) {
      app.cpuLimit = input.cpuLimit === null ? undefined : clampCpuLimit(input.cpuLimit);
    }
    if (input.autoScaleEnabled !== undefined) app.autoScaleEnabled = !!input.autoScaleEnabled;
    if (input.autoScaleMin !== undefined) app.autoScaleMin = clampReplicas(input.autoScaleMin);
    if (input.autoScaleMax !== undefined) app.autoScaleMax = clampReplicas(input.autoScaleMax);
    if (input.autoScaleCpuUp !== undefined) app.autoScaleCpuUp = clampPercent(input.autoScaleCpuUp, 70);
    if (input.autoScaleMemUp !== undefined) app.autoScaleMemUp = clampPercent(input.autoScaleMemUp, 80);
    if (input.autoScaleCpuDown !== undefined) app.autoScaleCpuDown = clampPercent(input.autoScaleCpuDown, 25);
    if (input.autoScaleMemDown !== undefined) app.autoScaleMemDown = clampPercent(input.autoScaleMemDown, 40);

    app.autoScaleMin = clampReplicas(app.autoScaleMin ?? 1);
    app.autoScaleMax = Math.max(app.autoScaleMin, clampReplicas(app.autoScaleMax ?? 3));
    if (app.autoScaleEnabled) {
      // Mantém réplicas dentro de [min, max]; se o usuário pediu um valor explícito, usa ele.
      const desired = clampReplicas(input.replicas ?? app.replicas ?? app.autoScaleMin);
      app.replicas = Math.min(app.autoScaleMax, Math.max(app.autoScaleMin, desired));
    } else {
      app.replicas = clampReplicas(app.replicas ?? 1);
    }
    app.memoryLimitMb = clampMemoryMb(app.memoryLimitMb ?? 512);
    app.status = 'deploying';
    app.lastError = undefined;
    app.updatedAt = Date.now();
    this.persist();

    this.runJob(app, async () => {
      // Se o stack já tem LB (modo escalável), só --scale — sem rebuild/prisma.
      const dest = `${SERVICOS_ROOT}/${app.slug}`;
      const check = await this.run(
        `[ -f ${shellQuote(dest + '/docker-compose.hub.yml')} ] && [ -f ${shellQuote(dest + '/hub-lb.conf')} ] && echo HAS_LB`,
        { timeout: 15000 }
      );
      const hasLb = `${check.stdout || ''}`.includes('HAS_LB');
      const limitsTouched = input.memoryLimitMb !== undefined || input.cpuLimit !== undefined;

      if (hasLb && needsScalableLayout(app) && !limitsTouched) {
        await this.scaleComposeReplicas(dest, clampReplicas(app.replicas ?? 1));
        app.lastScaleAt = Date.now();
      } else {
        await this.startBackend(app, input.linuxUsername, input.linuxPassword);
      }
      const nginx = await this.configureNginx(app, input.linuxUsername, input.linuxPassword);
      app.nginxEnabled = nginx.ok;
      app.nginxMessage = nginx.message;
    });
    return app;
  }

  private async scaleComposeReplicas(dest: string, replicas: number): Promise<void> {
    const script = `
DEST="$1"
REPLICAS="$2"
cd "$DEST" || exit 1
[ -f docker-compose.hub.yml ] || exit 1
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f docker-compose.hub.yml "$@"
  else
    docker-compose -f docker-compose.hub.yml "$@"
  fi
}
compose up -d --no-build --remove-orphans --scale api="$REPLICAS"
# Remove containers api extras órfãos se o compose não encolheru
echo SCALE_OK
`;
    const res = await this.runScript(script, [dest, String(replicas)], { timeout: 180000 });
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (!out.includes('SCALE_OK')) {
      throw new Error(res.stderr || res.stdout || 'Falha ao ajustar réplicas');
    }
  }

  /** Usado pelo autoscaler: só `--scale`, sem rebuild (stack já precisa estar em modo escalável). */
  async applyReplicaCountFast(id: string, targetReplicas: number): Promise<HubApplication | null> {
    const app = this.getById(id);
    if (!app?.hasBackend || !app.backendPort) return null;
    if (this.jobs.has(app.id) || app.status === 'deploying') return null;

    const target = clampReplicas(targetReplicas);
    const min = clampReplicas(app.autoScaleMin ?? 1);
    const max = Math.max(min, clampReplicas(app.autoScaleMax ?? 5));
    const next = Math.min(max, Math.max(min, target));
    if (next === clampReplicas(app.replicas ?? 1)) return app;

    if (!needsScalableLayout({ ...app, replicas: next, autoScaleMax: max })) {
      return null;
    }

    const dest = `${SERVICOS_ROOT}/${app.slug}`;
    const script = `
DEST="$1"
REPLICAS="$2"
cd "$DEST" || exit 1
[ -f docker-compose.hub.yml ] || exit 1
[ -f hub-lb.conf ] || exit 1
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f docker-compose.hub.yml "$@"
  else
    docker-compose -f docker-compose.hub.yml "$@"
  fi
}
compose up -d --no-build --remove-orphans --scale api="$REPLICAS"
echo SCALE_OK
`;
    const res = await this.runScript(script, [dest, String(next)], { timeout: 120000 });
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (!out.includes('SCALE_OK')) {
      throw new Error(res.stderr || res.stdout || 'Falha ao ajustar réplicas');
    }
    app.replicas = next;
    app.lastScaleAt = Date.now();
    app.updatedAt = Date.now();
    this.persist();
    return app;
  }

  private async deploy(
    app: HubApplication,
    input: {
      frontendZip?: string;
      backendZip?: string;
      linuxUsername?: string;
      linuxPassword?: string;
    }
  ): Promise<void> {
    const errors: string[] = [];

    if (input.frontendZip) {
      await this.extractArchive(input.frontendZip, `${APACHE_ROOT}/${app.slug}`, input);
      await this.prepareFrontend(
        `${APACHE_ROOT}/${app.slug}`,
        app.slug,
        input.linuxUsername,
        input.linuxPassword
      );
    }
    if (input.backendZip && app.backendPort) {
      await this.extractArchive(input.backendZip, `${SERVICOS_ROOT}/${app.slug}`, input);
      await this.startBackend(app, input.linuxUsername, input.linuxPassword);
    }

    await this.ensureApacheSpa({ username: input.linuxUsername, password: input.linuxPassword });
    this.assignPublicUrls(app);

    const nginx = await this.configureNginx(app, input.linuxUsername, input.linuxPassword);
    app.nginxEnabled = nginx.ok;
    app.nginxMessage = nginx.message;
    // Nginx no host e opcional — nao marca a publicacao como erro.
    if (!nginx.ok && !nginx.optional) errors.push(nginx.message);

    const cf = await this.syncCloudflareRoutes();
    app.cloudflareEnabled = cf.ok;
    app.cloudflareMessage = cf.message;
    if (!cf.ok) errors.push(cf.message);
    app.lastError = errors.filter(Boolean).join('\n') || undefined;
  }

  private async extractArchive(
    winZip: string,
    dest: string,
    opts: { linuxUsername?: string; linuxPassword?: string }
  ): Promise<string> {
    const wslZip = toWslPath(winZip);
    const script = `
ZIP="$1"
DEST="$2"
mkdir -p "$DEST"
find "$DEST" -mindepth 1 -delete 2>/dev/null || true
case "$ZIP" in
  *.tar.gz|*.tgz) tar -xzf "$ZIP" -C "$DEST" ;;
  *.tar) tar -xf "$ZIP" -C "$DEST" ;;
  *)
    if command -v python3 >/dev/null 2>&1; then
      python3 -c 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$ZIP" "$DEST"
    elif command -v unzip >/dev/null 2>&1; then
      unzip -o "$ZIP" -d "$DEST"
    else
      echo "python3 ou unzip necessario para extrair .zip" >&2
      exit 1
    fi
    ;;
esac
python3 - "$DEST" <<'PY'
import os, shutil, sys
dest = sys.argv[1]
entries = [e for e in os.listdir(dest) if e not in (".", "..")]
if len(entries) == 1:
    inner = os.path.join(dest, entries[0])
    if os.path.isdir(inner):
        for name in os.listdir(inner):
            shutil.move(os.path.join(inner, name), os.path.join(dest, name))
        try:
            os.rmdir(inner)
        except OSError:
            pass
PY
chmod -R a+rX "$DEST" || true
echo EXTRACT_OK
`;
    const res = await this.runScript(script, [wslZip, dest], {
      username: opts.linuxUsername,
      password: opts.linuxPassword,
      timeout: 180000,
    });
    try {
      fs.unlinkSync(winZip);
    } catch {
      /* ignore */
    }
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (!out.includes('EXTRACT_OK') && !res.success) {
      throw new Error(`Falha ao extrair arquivo em ${dest}: ${res.stderr || res.stdout || 'erro'}`);
    }
    return `Arquivos extraídos em ${dest}`;
  }

  private async prepareFrontend(
    dest: string,
    slug: string,
    username?: string,
    password?: string
  ): Promise<string> {
    const probe = await this.run(
      `if [ ! -f ${shellQuote(dest + '/index.html')} ]; then echo FRONTEND_NO_INDEX; elif grep -qE 'src/main\\.(tsx|jsx|ts|js)' ${shellQuote(
        dest + '/index.html'
      )}; then echo VITE_SRC; else echo FRONTEND_STATIC; fi`,
      { username, password, timeout: 15000 }
    );
    const probeOut = `${probe.stdout || ''}\n${probe.stderr || ''}`;
    if (probeOut.includes('FRONTEND_STATIC')) {
      return 'Frontend estático publicado';
    }
    if (!probeOut.includes('VITE_SRC')) {
      throw new Error('O frontend precisa de um index.html na raiz do ZIP.');
    }

    const pkgCheck = await this.run(`test -f ${shellQuote(dest + '/package.json')} && echo HAS_PKG || echo NO_PKG`, {
      username,
      password,
      timeout: 15000,
    });
    if (!`${pkgCheck.stdout || ''}`.includes('HAS_PKG')) {
      throw new Error(
        'O ZIP é um projeto Vite (index.html aponta para src/main.tsx). Envie o código-fonte completo com package.json, ou só a pasta dist já compilada.'
      );
    }

    const script = `
DEST="$1"
BASE="$2"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
hash -r
if ! command -v npm >/dev/null 2>&1; then
  echo "npm não encontrado no Ubuntu. Instale o Node.js no Linux." >&2
  exit 1
fi
BUILD="$(mktemp -d /tmp/hub-fe-XXXXXX)"
trap 'rm -rf "$BUILD"' EXIT
cp -a "$DEST"/. "$BUILD"/
chmod -R u+rwX "$BUILD" || true
rm -rf "$BUILD/node_modules"
cd "$BUILD"
npm install --ignore-scripts
npx --no-install vite build --base "$BASE"
test -f dist/index.html
find "$DEST" -mindepth 1 -delete
cp -a "$BUILD"/dist/. "$DEST"/
chmod -R a+rX "$DEST"
echo FRONTEND_BUILT
`;
    const build = await this.runScript(script, [dest, `/${slug}/`], {
      username,
      password,
      timeout: 360000,
    });
    const out = `${build.stdout || ''}\n${build.stderr || ''}`;
    if (!out.includes('FRONTEND_BUILT')) {
      throw new Error(build.stderr || build.stdout || 'Falha ao compilar o frontend Vite');
    }
    return 'Frontend Vite compilado e publicado';
  }

  private async startBackend(
    app: HubApplication,
    username?: string,
    password?: string
  ): Promise<string> {
    const slug = app.slug;
    const port = app.backendPort;
    if (!port) throw new Error('Porta do backend não definida');
    const replicas = clampReplicas(app.replicas ?? 1);
    const memoryLimitMb = clampMemoryMb(app.memoryLimitMb ?? 512);
    const cpuLimit = clampCpuLimit(app.cpuLimit);
    const scalable = needsScalableLayout(app);
    app.replicas = replicas;
    app.memoryLimitMb = memoryLimitMb;
    app.cpuLimit = cpuLimit;
    const routeSlug = this.publicRouteSlug(app);
    const dest = `${SERVICOS_ROOT}/${slug}`;
    const origin = publicOrigin();
    const cors = [origin, 'http://127.0.0.1:8081', 'http://localhost:8081'].join(',');
    const db = hubDatabaseUrlForApp(slug);
    const plan = await this.provisionBackendEnv(dest, routeSlug, cors, db, username, password);
    if (plan.needsDatabase) {
      await ensureAppDatabase(slug);
    }
    const compose = this.hubCompose(slug, port, plan, cors, routeSlug, {
      replicas,
      memoryLimitMb,
      cpuLimit,
      forceScalable: scalable,
    });
    const ymlTmp = writeTemp(`hub-stack-${slug}`, compose, '.yml');
    const lbConf =
      scalable
        ? [
            'resolver 127.0.0.11 valid=10s ipv6=off;',
            'server {',
            '  listen 80;',
            '  client_max_body_size 100m;',
            '  location / {',
            `    set $upstream http://api:${plan.innerPort || 3000};`,
            '    proxy_pass $upstream;',
            '    proxy_http_version 1.1;',
            '    proxy_set_header Host $host;',
            '    proxy_set_header X-Real-IP $remote_addr;',
            '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
            '    proxy_set_header X-Forwarded-Proto $scheme;',
            '    proxy_set_header Upgrade $http_upgrade;',
            '    proxy_set_header Connection "upgrade";',
            '  }',
            '}',
            '',
          ].join('\n')
        : '';
    const lbTmp = scalable ? writeTemp(`hub-lb-${slug}`, lbConf, '.conf') : '';
    try {
      const script = `
DEST="$1"
YMLSRC="$2"
PORT="$3"
HAS_PRISMA="$4"
REPLICAS="$5"
LBSRC="$6"
SCALABLE="$7"
mkdir -p "$DEST/uploads"
# Evita pasta root-owned (scale/.env sem sudo)
chmod -R u+rwX,g+rwX "$DEST" 2>/dev/null || true
cp "$YMLSRC" "$DEST/docker-compose.hub.yml"
if [ -n "$LBSRC" ] && [ -f "$LBSRC" ]; then
  cp "$LBSRC" "$DEST/hub-lb.conf"
else
  rm -f "$DEST/hub-lb.conf"
fi
cd "$DEST"
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f docker-compose.hub.yml "$@"
  else
    docker-compose -f docker-compose.hub.yml "$@"
  fi
}
compose down --remove-orphans >/dev/null 2>&1 || true
if [ "$SCALABLE" = "1" ]; then
  compose up -d --build --remove-orphans --scale api="$REPLICAS"
else
  compose up -d --build --remove-orphans
fi
ready=0
for i in $(seq 1 50); do
  for path in /health /api/health /; do
    if curl -sf --max-time 3 "http://127.0.0.1:$PORT$path" >/dev/null 2>&1; then
      ready=1
      break
    fi
  done
  [ "$ready" -eq 1 ] && break
  sleep 3
done
if [ "$ready" -ne 1 ]; then
  echo "API não respondeu em :$PORT" >&2
  compose logs --tail 120 api >&2 || true
  compose logs --tail 40 lb >&2 || true
  compose logs --tail 40 db >&2 || true
  exit 1
fi
if [ "$HAS_PRISMA" = "1" ]; then
  # Imagem runner costuma ter só @prisma/client. npx baixa Prisma 8 e quebra.
  # Se a API já respondeu, migrate é best-effort (não derruba o scale).
  if compose exec -T api sh -c 'test -x ./node_modules/.bin/prisma || test -f ./node_modules/prisma/package.json'; then
    compose exec -T api ./node_modules/.bin/prisma generate --schema prisma/schema.prisma 2>/dev/null \
      || compose exec -T api npx --no-install prisma generate --schema prisma/schema.prisma || true
    if ! compose exec -T api ./node_modules/.bin/prisma migrate deploy 2>/dev/null \
      && ! compose exec -T api npx --no-install prisma migrate deploy; then
      echo "migrate deploy falhou; tentando prisma db push" >&2
      compose exec -T api ./node_modules/.bin/prisma db push --accept-data-loss 2>/dev/null \
        || compose exec -T api npx --no-install prisma db push --accept-data-loss \
        || echo "Prisma migrate/push ignorado (API já saudável)." >&2
    fi
    compose exec -T api npm run db:constraints --if-present || true
    compose exec -T api npm run db:seed --if-present || true
  else
    echo "Prisma CLI ausente na imagem; pulando migrate (normal em produção)." >&2
  fi
fi
echo BACKEND_OK
`;
      const res = await this.runScript(
        script,
        [
          dest,
          toWslPath(ymlTmp),
          String(port),
          plan.hasPrisma ? '1' : '0',
          String(replicas),
          lbTmp ? toWslPath(lbTmp) : '',
          scalable ? '1' : '0',
        ],
        { username, password, timeout: 600000 }
      );
      const out = `${res.stdout || ''}\n${res.stderr || ''}`;
      if (!out.includes('BACKEND_OK')) {
        throw new Error(`Falha ao iniciar o backend: ${res.stderr || res.stdout || 'docker compose'}`);
      }
    } finally {
      try {
        fs.unlinkSync(ymlTmp);
      } catch {
        /* ignore */
      }
      if (lbTmp) {
        try {
          fs.unlinkSync(lbTmp);
        } catch {
          /* ignore */
        }
      }
    }
    const notes = [
      `Backend publicado na porta ${port}`,
      scalable
        ? `${replicas} réplica(s) + load balancer${app.autoScaleEnabled ? ' · auto-scale ON' : ''}`
        : '1 réplica',
      `limite ${memoryLimitMb}MB RAM` + (cpuLimit ? ` / ${cpuLimit} CPU` : ''),
    ];
    if (plan.needsDatabase) notes.push(`banco ${db.name} criado no PostgreSQL do Hub`);
    if (plan.needsRedis) notes.push('Redis no ar');
    if (plan.convertedPrisma) notes.push('schema Prisma convertido para PostgreSQL');
    return notes.join('. ');
  }

  private async provisionBackendEnv(
    dest: string,
    slug: string,
    cors: string,
    db: { name: string; user: string; password: string; url: string },
    username?: string,
    password?: string
  ): Promise<BackendPlan> {
    const py = writeTemp(
      'hub-env-patch',
      `import json, re, sys
from pathlib import Path

dest = Path(sys.argv[1])
slug = sys.argv[2]
cors = sys.argv[3]
jwt = sys.argv[4]
hub_db_url = sys.argv[5]
hub_db_user = sys.argv[6]
hub_db_password = sys.argv[7]
hub_db_name = sys.argv[8]

def parse_env(text):
    data = {}
    for line in text.splitlines():
        raw = line.strip()
        if not raw or raw.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key = key.strip()
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        if key:
            data[key] = value
    return data

env = {}
env_file = dest / '.env'
example = dest / '.env.example'
if example.is_file():
    env.update(parse_env(example.read_text(encoding='utf-8', errors='replace')))
if env_file.is_file():
    env.update(parse_env(env_file.read_text(encoding='utf-8', errors='replace')))

pkg = {}
package_json = dest / 'package.json'
if package_json.is_file():
    try:
        pkg = json.loads(package_json.read_text(encoding='utf-8'))
    except Exception:
        pkg = {}
deps = {}
deps.update(pkg.get('dependencies') or {})
deps.update(pkg.get('devDependencies') or {})
scripts = pkg.get('scripts') or {}

schema = dest / 'prisma' / 'schema.prisma'
has_prisma = schema.is_file()
dockerfile = dest / 'Dockerfile'
has_df = dockerfile.is_file()
df_text = dockerfile.read_text(encoding='utf-8', errors='replace') if has_df else ''
# Preferir estágio de produção; nunca forçar target:dev no Hub
if re.search(r'\\bAS\\s+runner\\b', df_text, re.I):
    dockerfile_target = 'runner'
elif re.search(r'\\bAS\\s+prod\\b', df_text, re.I):
    dockerfile_target = 'prod'
elif re.search(r'\\bAS\\s+production\\b', df_text, re.I):
    dockerfile_target = 'production'
else:
    dockerfile_target = ''

converted = False
if has_prisma:
    text = schema.read_text(encoding='utf-8', errors='replace')
    match = re.search(r'datasource\\s+\\w+\\s*\\{[^}]*provider\\s*=\\s*"(\\w+)"', text, re.S)
    provider = match.group(1) if match else ''
    if provider in ('mysql', 'sqlite', 'sqlserver', 'mongodb'):
        text = re.sub(
            r'(datasource\\s+\\w+\\s*\\{[^}]*?)provider\\s*=\\s*"[^"]+"',
            r'\\1provider = "postgresql"',
            text,
            count=1,
            flags=re.S,
        )
        schema.write_text(text, encoding='utf-8')
        lock = dest / 'prisma' / 'migrations' / 'migration_lock.toml'
        if lock.is_file():
            lock.write_text('# Please do not edit this file manually\\nprovider = "postgresql"\\n', encoding='utf-8')
        converted = True

need_db = has_prisma or any(key in env for key in (
    'DATABASE_URL', 'MYSQL_URL', 'MYSQL_HOST', 'MYSQL_DATABASE', 'DB_HOST', 'POSTGRES_DB', 'POSTGRES_USER'
)) or any(name in deps for name in ('prisma', 'pg', 'mysql', 'mysql2', 'mariadb', 'better-sqlite3', 'sqlite3'))
need_redis = 'REDIS_URL' in env or any(name in deps for name in ('ioredis', 'bullmq', 'redis'))

if need_db:
    env['POSTGRES_USER'] = hub_db_user
    env['POSTGRES_PASSWORD'] = hub_db_password
    env['POSTGRES_DB'] = hub_db_name
    env['DATABASE_URL'] = hub_db_url
    for key in ('MYSQL_URL', 'MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'MYSQL_PORT'):
        env.pop(key, None)

if need_redis:
    env['REDIS_URL'] = 'redis://redis:6379'

env['PUBLIC_PATH'] = '/' + slug
env['TRUST_PROXY'] = '172.16.0.0/12'
env['API_HOST'] = '0.0.0.0'
env['CORS_ORIGINS'] = cors
env['TZ'] = env.get('TZ') or 'America/Sao_Paulo'
if env.get('PAYMENT_PROVIDER') == 'fake' or env.get('ALLOW_FAKE_WEBHOOK') == 'true':
    env['NODE_ENV'] = 'development'
elif not env.get('NODE_ENV') or env.get('NODE_ENV') == 'development':
    env['NODE_ENV'] = 'production'
if len(env.get('JWT_SECRET') or '') < 32:
    env['JWT_SECRET'] = jwt

try:
    inner = int(env.get('API_PORT') or env.get('PORT') or (4000 if (has_prisma or has_df) else 3000))
except ValueError:
    inner = 4000 if (has_prisma or has_df) else 3000
env['API_PORT'] = str(inner)
env['PORT'] = str(inner)

has_worker = False
worker_cmd = ''
if 'start:worker' in scripts:
    has_worker = True
    worker_cmd = 'npm run start:worker'
elif 'worker' in scripts:
    has_worker = True
    worker_cmd = 'npm run worker'
elif 'dev:worker' in scripts:
    has_worker = True
    worker_cmd = 'node dist/worker.js'

priority = [
    'NODE_ENV', 'TRUST_PROXY', 'TZ', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB',
    'DATABASE_URL', 'REDIS_URL', 'API_PORT', 'API_HOST', 'PORT', 'PUBLIC_PATH',
    'CORS_ORIGINS', 'LOG_LEVEL', 'JWT_SECRET',
]
lines = ['# Ajustado pelo Central Hub. DATABASE_URL aponta para o PostgreSQL do Hub (pgAdmin).', '']
seen = set()
for key in priority:
    if key in env:
        lines.append('%s=%s' % (key, env[key]))
        seen.add(key)
for key, value in env.items():
    if key in seen:
        continue
    lines.append('%s=%s' % (key, value))
env_file.write_text('\\n'.join(lines) + '\\n', encoding='utf-8')

print('HUB_INSPECT=' + json.dumps({
    'hasDockerfile': has_df,
    'dockerfileTarget': dockerfile_target,
    'hasPrisma': has_prisma,
    'hasPackage': package_json.is_file(),
    'hasWorker': has_worker,
    'workerCommand': worker_cmd,
    'needsDatabase': need_db,
    'needsRedis': need_redis,
    'convertedPrisma': converted,
    'innerPort': inner,
}, separators=(',', ':')))
`,
      '.py'
    );
    try {
      const res = await this.run(
        `python3 ${shellQuote(toWslPath(py))} ${[
          dest,
          slug,
          cors,
          randomBytes(36).toString('base64url'),
          db.url,
          db.user,
          db.password,
          db.name,
        ]
          .map(shellQuote)
          .join(' ')}`,
        { username, password, timeout: 30000 }
      );
      const match = `${res.stdout || ''}\n${res.stderr || ''}`.match(/HUB_INSPECT=(\{.*\})/);
      if (!match) {
        throw new Error(
          `Não foi possível ajustar o .env do backend: ${res.stderr || res.stdout || 'python'}`
        );
      }
      return JSON.parse(match[1]) as BackendPlan;
    } finally {
      try {
        fs.unlinkSync(py);
      } catch {
        /* ignore */
      }
    }
  }

  private hubCompose(
    slug: string,
    hostPort: number,
    plan: BackendPlan,
    cors: string,
    routeSlug = slug,
    scaling: {
      replicas: number;
      memoryLimitMb: number;
      cpuLimit?: number;
      forceScalable?: boolean;
    } = {
      replicas: 1,
      memoryLimitMb: 512,
    }
  ): string {
    const inner = plan.innerPort || 3000;
    const replicas = clampReplicas(scaling.replicas);
    const memoryLimitMb = clampMemoryMb(scaling.memoryLimitMb);
    const cpuLimit = clampCpuLimit(scaling.cpuLimit);
    const scaled = !!scaling.forceScalable || replicas > 1;
    const depends: string[] = [];
    if (plan.needsRedis) depends.push('      redis: { condition: service_healthy }');
    const dependsBlock = depends.length
      ? ['    depends_on:', ...depends].join('\n')
      : '';

    const apiImage = plan.hasDockerfile
      ? [
          `    image: hub-${slug}-api:latest`,
          '    build:',
          '      context: .',
          '      dockerfile: Dockerfile',
          ...(plan.dockerfileTarget ? [`      target: ${plan.dockerfileTarget}`] : []),
        ]
      : [
          '    image: node:22-bookworm-slim',
          '    working_dir: /app',
          '    command: bash -lc "npm install && (npx prisma generate --schema prisma/schema.prisma || true) && (npm run start --if-present || node dist/server.js || node dist/index.js || node server.js || node index.js)"',
          '    volumes:',
          '      - .:/app',
        ];

    const resourceLimits = resourceLimitLines(memoryLimitMb, cpuLimit, 64);

    const apiHealthcheck = [
      '    healthcheck:',
      `      test: ["CMD", "node", "-e", "require('net').createConnection(${inner},'127.0.0.1').on('connect',function(){this.end();process.exit(0)}).on('error',function(){process.exit(1)})"]`,
      '      interval: 15s',
      '      timeout: 5s',
      '      retries: 5',
      '      start_period: 40s',
    ];

    const lines = [`name: hub-${slug}`, 'services:'];

    if (plan.needsRedis) {
      lines.push(
        '  redis:',
        '    image: redis:7-alpine',
        `    container_name: hub-${slug}-redis`,
        '    restart: unless-stopped',
        '    healthcheck:',
        "      test: ['CMD', 'redis-cli', 'ping']",
        '      interval: 5s',
        '      timeout: 3s',
        '      retries: 10',
        ...resourceLimitLines(128, undefined, 32),
        '    networks: [hub]'
      );
    }

    lines.push(
      '  api:',
      ...apiImage,
      ...(scaled ? [] : [`    container_name: hub-${slug}-api`]),
      '    restart: unless-stopped',
      '    env_file: [.env]',
      '    environment:',
      '      DATABASE_URL: ${DATABASE_URL}',
      '      REDIS_URL: ${REDIS_URL}',
      '      API_HOST: 0.0.0.0',
      `      API_PORT: "${inner}"`,
      `      PORT: "${inner}"`,
      `      PUBLIC_PATH: /${routeSlug}`,
      `      CORS_ORIGINS: ${cors}`,
      '      TRUST_PROXY: 172.16.0.0/12',
      ...(scaled
        ? ['    expose:', `      - "${inner}"`]
        : ['    ports:', `      - "${hostPort}:${inner}"`]),
      '    extra_hosts:',
      '      - "host.docker.internal:host-gateway"',
      ...(plan.hasDockerfile ? ['    volumes:', '      - ./uploads:/app/uploads'] : []),
      ...apiHealthcheck,
      ...resourceLimits,
      ...(dependsBlock ? dependsBlock.split('\n') : []),
      '    networks: [hub]'
    );

    if (scaled) {
      lines.push(
        '  lb:',
        '    image: nginx:1.27-alpine',
        `    container_name: hub-${slug}-lb`,
        '    restart: unless-stopped',
        '    ports:',
        `      - "${hostPort}:80"`,
        '    volumes:',
        '      - ./hub-lb.conf:/etc/nginx/conf.d/default.conf:ro',
        '    depends_on:',
        '      - api',
        ...resourceLimitLines(64, 0.25, 16),
        '    networks: [hub]'
      );
    }

    if (plan.hasWorker && plan.workerCommand) {
      const workerImage = plan.hasDockerfile
        ? [
            `    image: hub-${slug}-worker:latest`,
            '    build:',
            '      context: .',
            '      dockerfile: Dockerfile',
            ...(plan.dockerfileTarget ? [`      target: ${plan.dockerfileTarget}`] : []),
          ]
        : ['    image: node:22-bookworm-slim', '    working_dir: /app', '    volumes:', '      - .:/app'];
      lines.push(
        '  worker:',
        ...workerImage,
        `    container_name: hub-${slug}-worker`,
        '    restart: unless-stopped',
        `    command: ${plan.workerCommand}`,
        '    env_file: [.env]',
        '    environment:',
        '      DATABASE_URL: ${DATABASE_URL}',
        '      REDIS_URL: ${REDIS_URL}',
        `      PUBLIC_PATH: /${routeSlug}`,
        '    extra_hosts:',
        '      - "host.docker.internal:host-gateway"',
        ...resourceLimitLines(memoryLimitMb, cpuLimit, 64),
        ...(dependsBlock ? dependsBlock.split('\n') : []),
        '    networks: [hub]'
      );
    }

    lines.push('networks:', '  hub:', '');
    return lines.join('\n');
  }

  private nginxConf(app: HubApplication): string {
    const apiBlock = app.backendPort
      ? `
    location /api/ {
        proxy_pass http://127.0.0.1:${app.backendPort}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
`
      : '';

    const rootBlock = app.hasFrontend
      ? `
    location / {
        proxy_pass http://127.0.0.1:8081/${app.slug}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
`
      : app.backendPort
      ? `
    location / {
        proxy_pass http://127.0.0.1:${app.backendPort}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
`
      : `
    location / { return 404; }
`;

    return `server {
    listen ${app.publicPort};
    server_name ${app.slug}.central-apps-hub.com.br ${app.slug}.localhost ${app.slug}.local _;
${apiBlock}${rootBlock}}
`;
  }

  private async configureNginx(
    app: HubApplication,
    username?: string,
    password?: string
  ): Promise<{ ok: boolean; message: string; optional?: boolean }> {
    const tmp = writeTemp(`hub-nginx-${app.slug}`, this.nginxConf(app), '.conf');
    try {
      // Nginx no host (porta publica 81xx) e opcional: o Hub ja publica via Apache/Cloudflare.
      // /etc/nginx e root — sem sudo passwordless gravamos em /hub-apps/nginx e tentamos reload.
      const script = `
SRC="$1"
SLUG="$2"
HUB_NGINX_DIR="/hub-apps/nginx/conf.d"
DEST_HUB="$HUB_NGINX_DIR/hub-app-$SLUG.conf"
DEST_ETC="/etc/nginx/conf.d/hub-app-$SLUG.conf"

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n "$@"
  else
    return 1
  fi
}

if ! command -v nginx >/dev/null 2>&1; then
  echo NGINX_MISSING
  exit 0
fi

mkdir -p "$HUB_NGINX_DIR" 2>/dev/null || true
cp "$SRC" "$DEST_HUB" 2>/dev/null || true

installed=0
if as_root cp "$SRC" "$DEST_ETC" 2>/dev/null; then
  installed=1
  if [ -d /etc/nginx/sites-available ]; then
    as_root mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled 2>/dev/null || true
    as_root cp "$SRC" "/etc/nginx/sites-available/hub-app-$SLUG" 2>/dev/null || true
    as_root ln -sfn "/etc/nginx/sites-available/hub-app-$SLUG" "/etc/nginx/sites-enabled/hub-app-$SLUG" 2>/dev/null || true
  fi
elif [ -f "$DEST_HUB" ] && grep -Rqs "$HUB_NGINX_DIR" /etc/nginx 2>/dev/null; then
  installed=1
fi

if [ "$installed" -eq 1 ]; then
  if as_root nginx -t >/dev/null 2>&1; then
    as_root nginx -s reload 2>/dev/null \\
      || as_root systemctl reload nginx 2>/dev/null \\
      || as_root service nginx reload 2>/dev/null \\
      || true
    echo NGINX_OK
    exit 0
  fi
  echo NGINX_TEST_FAIL
  exit 0
fi

echo NGINX_SKIPPED
exit 0
`;
      const res = await this.runScript(script, [toWslPath(tmp), app.slug], {
        username,
        password,
        timeout: 60000,
      });
      const out = `${res.stdout || ''}\n${res.stderr || ''}`;
      if (out.includes('NGINX_MISSING')) {
        return {
          ok: false,
          optional: true,
          message:
            'Nginx no host ausente (opcional). App publicada via Apache/Cloudflare em /{slug}/.',
        };
      }
      if (out.includes('NGINX_OK')) {
        return { ok: true, message: `Nginx escutando na porta ${app.publicPort}` };
      }
      if (out.includes('NGINX_SKIPPED')) {
        return {
          ok: false,
          optional: true,
          message:
            'Nginx no host pulado (sem sudo em /etc/nginx). App ok no Apache/Cloudflare. Para habilitar: sudo bash deploy/nginx/enable-hub-nginx.sh',
        };
      }
      if (out.includes('NGINX_TEST_FAIL')) {
        return {
          ok: false,
          optional: true,
          message: 'Nginx -t falhou; conf nao aplicada. App permanece no Apache/Cloudflare.',
        };
      }
      return {
        ok: false,
        optional: true,
        message: (out.trim() || 'Nginx no host nao configurado').slice(0, 400),
      };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  private apacheManagedBlock(): string {
    const parts = [BEGIN_MARK];
    const proxiedRoutes = new Set<string>();

    for (const app of this.items) {
      if (app.hasFrontend) {
        parts.push(
          `<Directory "/usr/local/apache2/htdocs/${app.slug}">\n    Options FollowSymLinks\n    AllowOverride None\n    Require all granted\n    FallbackResource /${app.slug}/index.html\n</Directory>`
        );
      }
      if (app.hasBackend && app.backendPort) {
        const route = this.publicRouteSlug(app);
        if (!proxiedRoutes.has(route)) {
          proxiedRoutes.add(route);
          parts.push(
            `<Location /${route}/api/>\n    ProxyPass http://${APACHE_BACKEND_HOST}:${app.backendPort}/\n    ProxyPassReverse http://${APACHE_BACKEND_HOST}:${app.backendPort}/\n</Location>`
          );
          parts.push(
            `<Location /${route}/uploads/>\n    ProxyPass http://${APACHE_BACKEND_HOST}:${app.backendPort}/uploads/\n    ProxyPassReverse http://${APACHE_BACKEND_HOST}:${app.backendPort}/uploads/\n</Location>`
          );
        }
        if (!app.hasFrontend && route === app.slug) {
          parts.push(
            `<Location /${route}/>\n    ProxyPass http://${APACHE_BACKEND_HOST}:${app.backendPort}/\n    ProxyPassReverse http://${APACHE_BACKEND_HOST}:${app.backendPort}/\n</Location>`
          );
        }
      }
    }
    parts.push(END_MARK);
    return parts.join('\n');
  }

  async repairRoutes(): Promise<void> {
    const merged = await this.mergeSplitApps();
    let changed = merged;
    for (const app of this.items) {
      if (this.assignPublicUrls(app)) changed = true;
    }
    if (changed) this.persist();
    await this.ensureApacheSpa();
    for (const app of this.items) {
      if (!app.hasBackend || !app.backendPort) continue;
      const route = this.publicRouteSlug(app);
      if (route === app.slug) continue;
      await this.patchBackendPublicPath(app, route);
    }
  }

  /**
   * Une apps publicados em par (frontend `foo` + backend `foo-api`) num único registro `foo`.
   */
  async mergeSplitApps(): Promise<boolean> {
    const removeIds = new Set<string>();
    let changed = false;

    for (const frontend of this.items.filter((a) => a.hasFrontend && !a.hasBackend)) {
      const backend = this.items.find(
        (a) =>
          a.id !== frontend.id &&
          !a.hasFrontend &&
          a.hasBackend &&
          (a.slug === `${frontend.slug}-api` || a.slug === `${frontend.slug}-backend`)
      );
      if (!backend) continue;

      await this.consolidateBackendDeploy(frontend.slug, backend.slug, backend.backendPort);

      frontend.hasBackend = true;
      frontend.backendPort = backend.backendPort;
      frontend.backendPath = `${SERVICOS_ROOT}/${frontend.slug}`;
      frontend.status = 'active';
      frontend.lastError = undefined;
      frontend.updatedAt = Date.now();
      this.assignPublicUrls(frontend);
      removeIds.add(backend.id);
      changed = true;
    }

    if (!changed) return false;
    this.items = this.items.filter((a) => !removeIds.has(a.id));
    this.persist();
    return true;
  }

  private async consolidateBackendDeploy(
    targetSlug: string,
    sourceSlug: string,
    port?: number
  ): Promise<void> {
    const script = `
TARGET="$1"
SOURCE="$2"
PORT="$3"
SERVICOS="/hub-apps/servicos"
FROM="$SERVICOS/$SOURCE"
TO="$SERVICOS/$TARGET"

stop_stack() {
  local dir="$1"
  [ -f "$dir/docker-compose.hub.yml" ] || return 0
  (cd "$dir" && docker compose -f docker-compose.hub.yml down --remove-orphans 2>/dev/null) || true
}

stop_stack "$FROM"
stop_stack "$TO"
docker rm -f "hub-$SOURCE" "hub-$SOURCE-api" "hub-$SOURCE-worker" "hub-$SOURCE-db" "hub-$SOURCE-redis" 2>/dev/null || true
docker rm -f "hub-$SOURCE-api-api" "hub-$SOURCE-api-worker" "hub-$SOURCE-api-db" "hub-$SOURCE-api-redis" 2>/dev/null || true
docker rm -f "hub-$SOURCE-2-api" "hub-$SOURCE-2-worker" "hub-$SOURCE-2-db" "hub-$SOURCE-2-redis" 2>/dev/null || true

if [ -d "$FROM" ] && [ "$FROM" != "$TO" ]; then
  rm -rf "$TO" 2>/dev/null || true
  mv "$FROM" "$TO"
fi

if [ ! -d "$TO" ]; then
  echo "Pasta do backend ausente: $TO" >&2
  exit 1
fi

docker run --rm -e TARGET="$TARGET" -v "$TO:/app" alpine sh -c '
  if [ -f /app/.env ]; then
    if grep -q "^PUBLIC_PATH=" /app/.env; then
      sed -i "s|^PUBLIC_PATH=.*|PUBLIC_PATH=/$TARGET|" /app/.env
    else
      echo "PUBLIC_PATH=/$TARGET" >> /app/.env
    fi
  fi
  if [ -f /app/docker-compose.hub.yml ]; then
    sed -i "s|PUBLIC_PATH: /[^[:space:]]*|PUBLIC_PATH: /$TARGET|g" /app/docker-compose.hub.yml
  fi
'

if [ -f "$TO/docker-compose.hub.yml" ]; then
  cd "$TO"
  if docker compose version >/dev/null 2>&1; then
    docker compose -f docker-compose.hub.yml up -d --build
  else
    docker-compose -f docker-compose.hub.yml up -d --build
  fi
  ready=0
  for i in $(seq 1 40); do
  if curl -sf --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 3
  done
  [ "$ready" -eq 1 ] || { echo "Backend não respondeu na porta $PORT" >&2; exit 1; }
fi
echo CONSOLIDATE_OK
`;
    const res = await this.runScript(script, [targetSlug, sourceSlug, String(port || '')], {
      timeout: 600000,
    });
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (!out.includes('CONSOLIDATE_OK')) {
      throw new Error(res.stderr || res.stdout || 'Falha ao consolidar backend');
    }
  }

  private async patchBackendPublicPath(app: HubApplication, routeSlug: string): Promise<void> {
    const dest = `${SERVICOS_ROOT}/${app.slug}`;
    const script = `
DEST="$1"
ROUTE="$2"
if [ ! -d "$DEST" ]; then exit 0; fi
patch_env() {
  local file="$1"
  if [ ! -f "$file" ]; then return 0; fi
  if [ -w "$file" ]; then
    if grep -q '^PUBLIC_PATH=' "$file"; then
      sed -i "s|^PUBLIC_PATH=.*|PUBLIC_PATH=/$ROUTE|" "$file"
    else
      echo "PUBLIC_PATH=/$ROUTE" >> "$file"
    fi
    return 0
  fi
  docker run --rm -e ROUTE="$ROUTE" -v "$DEST:/app" alpine sh -c '
    if grep -q "^PUBLIC_PATH=" /app/.env 2>/dev/null; then
      sed -i "s|^PUBLIC_PATH=.*|PUBLIC_PATH=/$ROUTE|" /app/.env
    else
      echo "PUBLIC_PATH=/$ROUTE" >> /app/.env
    fi
    if [ -f /app/docker-compose.hub.yml ]; then
      sed -i "s|PUBLIC_PATH: /[^[:space:]]*|PUBLIC_PATH: /$ROUTE|g" /app/docker-compose.hub.yml
    fi
  ' 2>/dev/null || true
}
patch_env "$DEST/.env"
if [ -f "$DEST/docker-compose.hub.yml" ]; then
  cd "$DEST"
  compose() {
    if docker compose version >/dev/null 2>&1; then
      docker compose -f docker-compose.hub.yml "$@"
    else
      docker-compose -f docker-compose.hub.yml "$@"
    fi
  }
  compose up -d --force-recreate api worker 2>/dev/null || compose up -d --force-recreate api 2>/dev/null || true
fi
echo PATCH_OK
`;
    await this.runScript(script, [dest, routeSlug], { timeout: 180000 });
  }

  private async ensureApacheSpa(opts?: { username?: string; password?: string }): Promise<void> {
    const managed = this.apacheManagedBlock();

    const tmp = writeTemp('hub-apache-apps', managed, '.conf');
    const py = writeTemp(
      'hub-apache-patch',
      `
from pathlib import Path
import sys
conf = Path(sys.argv[1])
block = Path(sys.argv[2]).read_text()
begin, end = sys.argv[3], sys.argv[4]
text = conf.read_text() if conf.exists() else ""
if begin in text and end in text:
    pre, rest = text.split(begin, 1)
    _, post = rest.split(end, 1)
    text = pre.rstrip() + "\\n\\n" + block + "\\n" + post.lstrip()
else:
    text = text.rstrip() + "\\n\\n" + block + "\\n"
conf.write_text(text)
print("APACHE_PATCH_OK")
`,
      '.py'
    );

    try {
      const script = `
CONF="$1"
BLOCK="$2"
PY="$3"
BEGIN="$4"
END="$5"
if [ ! -f "$CONF" ]; then
  echo APACHE_SKIP
  exit 0
fi
python3 "$PY" "$CONF" "$BLOCK" "$BEGIN" "$END"
docker exec apache httpd -k graceful 2>/dev/null || docker exec apache httpd -k restart 2>/dev/null || true
echo APACHE_OK
`;
      await this.runScript(script, [APACHE_CONF, toWslPath(tmp), toWslPath(py), BEGIN_MARK, END_MARK], {
        username: opts?.username,
        password: opts?.password,
        timeout: 60000,
      });
    } finally {
      try {
        fs.unlinkSync(tmp);
        fs.unlinkSync(py);
      } catch {
        /* ignore */
      }
    }
  }

  async remove(
    id: string,
    opts?: { linuxUsername?: string; linuxPassword?: string }
  ): Promise<void> {
    const app = this.getById(id);
    if (!app) throw new Error('Aplicação não encontrada');

    const installed = await appsService.listInstalled();
    await cloudflareService.unpublishApp(
      this.items.filter((a) => a.id !== id).map((a) => a.slug),
      appsService.getInstalledTunnelPaths(installed)
    );

    const script = `
SLUG="$1"
FRONT="$2"
BACK="$3"
docker compose -f "$BACK/docker-compose.hub.yml" down 2>/dev/null || true
docker compose -f "$BACK/docker-compose.yml" down 2>/dev/null || true
docker rm -f "hub-$SLUG" "hub-$SLUG-api" "hub-$SLUG-worker" "hub-$SLUG-redis" "hub-$SLUG-db" 2>/dev/null || true
rm -f "/etc/nginx/conf.d/hub-app-$SLUG.conf" "/etc/nginx/sites-available/hub-app-$SLUG" "/etc/nginx/sites-enabled/hub-app-$SLUG" 2>/dev/null || true
rm -rf "$FRONT" "$BACK"
if command -v nginx >/dev/null 2>&1; then
  nginx -t >/dev/null 2>&1 && (nginx -s reload 2>/dev/null || true) || true
fi
echo REMOVE_OK
`;
    await this.runScript(
      script,
      [app.slug, `${APACHE_ROOT}/${app.slug}`, `${SERVICOS_ROOT}/${app.slug}`],
      {
        username: opts?.linuxUsername,
        password: opts?.linuxPassword,
        timeout: 120000,
      }
    );

    if (app.hasBackend) {
      try {
        await dropAppDatabase(app.slug);
      } catch (err) {
        console.error(`Falha ao remover o banco ${appDatabaseName(app.slug)}:`, err);
      }
    }

    this.items = this.items.filter((a) => a.id !== id);
    this.persist();
    if (app.hasFrontend) {
      await this.ensureApacheSpa({ username: opts?.linuxUsername, password: opts?.linuxPassword });
    }
  }

  async publishCloudflare(id: string): Promise<HubApplication> {
    const app = this.getById(id);
    if (!app) throw new Error('Aplicação não encontrada');
    const cf = await this.syncCloudflareRoutes();
    app.cloudflareEnabled = cf.ok;
    app.cloudflareMessage = cf.message;
    app.updatedAt = Date.now();
    this.persist();
    return app;
  }
}

export const applicationsService = new ApplicationsService();
