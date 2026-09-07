import { applicationsService } from './applications.service';
import { serverManagerService } from './server-manager.service';

const INTERVAL_MS = 45_000;
const COOLDOWN_MS = 90_000;
const CONFIRM_TICKS = 2;

type Sample = { high: number; low: number };

/**
 * Auto-scale de backends publicados pelo Hub (upload).
 * Lê `docker stats`, sobe/desce réplicas dentro de min/max com cooldown.
 * Não usa Kubernetes — funciona no Compose single-host.
 */
class AutoScaleService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private samples = new Map<string, Sample>();

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.warn('Auto-scale:', err?.message || err);
      });
    }, INTERVAL_MS);
    // primeiro tick após aquecer
    setTimeout(() => {
      this.tick().catch(() => undefined);
    }, 15_000);
    console.log('Auto-scale: monitorando apps de upload a cada 45s');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const apps = applicationsService
        .list()
        .filter((a) => a.hasBackend && a.autoScaleEnabled && a.status === 'active');
      if (!apps.length) return;

      const stats = await this.readDockerStats();
      for (const app of apps) {
        await this.evaluateApp(app.id, app.slug, stats);
      }
    } finally {
      this.running = false;
    }
  }

  private async readDockerStats(): Promise<Map<string, { cpu: number; mem: number }>> {
    const map = new Map<string, { cpu: number; mem: number }>();
    const res = await serverManagerService.executeCommand({
      command:
        "docker stats --no-stream --format '{{.Name}}\\t{{.CPUPerc}}\\t{{.MemPerc}}' 2>/dev/null || true",
      timeout: 20000,
    });
    const lines = String(res.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const [name, cpuRaw, memRaw] = line.split('\t');
      if (!name) continue;
      const cpu = parseFloat(String(cpuRaw || '').replace('%', ''));
      const mem = parseFloat(String(memRaw || '').replace('%', ''));
      if (!Number.isFinite(cpu) || !Number.isFinite(mem)) continue;
      map.set(name, { cpu, mem });
    }
    return map;
  }

  private avgForSlug(
    slug: string,
    stats: Map<string, { cpu: number; mem: number }>
  ): { cpu: number; mem: number; count: number } | null {
    const prefix = `hub-${slug}-api`;
    const values: { cpu: number; mem: number }[] = [];
    for (const [name, v] of stats) {
      // compose: hub-<slug>-api-1 | legado: hub-<slug>-api
      if (name === prefix || name.startsWith(`${prefix}-`)) {
        values.push(v);
      }
    }
    if (!values.length) return null;
    const cpu = values.reduce((s, v) => s + v.cpu, 0) / values.length;
    const mem = values.reduce((s, v) => s + v.mem, 0) / values.length;
    return { cpu, mem, count: values.length };
  }

  private async evaluateApp(
    id: string,
    slug: string,
    stats: Map<string, { cpu: number; mem: number }>
  ): Promise<void> {
    const app = applicationsService.getById(id);
    if (!app?.autoScaleEnabled) return;

    const avg = this.avgForSlug(slug, stats);
    if (!avg) return;

    const min = Math.max(1, Math.min(5, app.autoScaleMin ?? 1));
    const max = Math.max(min, Math.min(5, app.autoScaleMax ?? 3));
    const current = Math.max(1, Math.min(5, app.replicas ?? avg.count ?? 1));
    const cpuUp = app.autoScaleCpuUp ?? 70;
    const memUp = app.autoScaleMemUp ?? 80;
    const cpuDown = app.autoScaleCpuDown ?? 25;
    const memDown = app.autoScaleMemDown ?? 40;

    const sample = this.samples.get(id) || { high: 0, low: 0 };
    const isHigh = avg.cpu >= cpuUp || avg.mem >= memUp;
    const isLow = avg.cpu <= cpuDown && avg.mem <= memDown;

    if (isHigh) {
      sample.high += 1;
      sample.low = 0;
    } else if (isLow) {
      sample.low += 1;
      sample.high = 0;
    } else {
      sample.high = 0;
      sample.low = 0;
    }
    this.samples.set(id, sample);

    const last = app.lastScaleAt || 0;
    if (Date.now() - last < COOLDOWN_MS) return;

    let target: number | null = null;
    if (sample.high >= CONFIRM_TICKS && current < max) {
      target = current + 1;
    } else if (sample.low >= CONFIRM_TICKS && current > min) {
      target = current - 1;
    }
    if (target == null) return;

    try {
      const updated = await applicationsService.applyReplicaCountFast(id, target);
      if (updated) {
        this.samples.set(id, { high: 0, low: 0 });
        console.log(
          `Auto-scale: ${slug} ${current}→${updated.replicas} (cpu=${avg.cpu.toFixed(1)}% mem=${avg.mem.toFixed(1)}%)`
        );
      }
    } catch (err: any) {
      console.warn(`Auto-scale falhou (${slug}):`, err?.message || err);
    }
  }
}

export const autoScaleService = new AutoScaleService();
