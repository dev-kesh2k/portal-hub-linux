import { serverManagerService } from './server-manager.service';

export type CloudflarePublishResult = { ok: boolean; message: string };

type TunnelIngress = {
  hostname?: string;
  path?: string;
  service: string;
  originRequest?: Record<string, unknown>;
};

type TunnelConfig = {
  ingress?: TunnelIngress[];
  [key: string]: unknown;
};

const RESERVED_PATHS = new Set(['api', 'health', 'ws', 'central-apps-hub', 'www']);

function publicOrigin(): string {
  return String(process.env.PUBLIC_ORIGIN || 'https://central-apps-hub.com.br').replace(/\/$/, '');
}

function publicHostname(): string {
  try {
    return new URL(publicOrigin()).hostname;
  } catch {
    return 'central-apps-hub.com.br';
  }
}

function originService(): string {
  return process.env.CF_ORIGIN_SERVICE || 'http://127.0.0.1:8081';
}

function cleanSlug(slug: string): string {
  return String(slug || '').replace(/^\/+|\/+$/g, '');
}

function pathPattern(slug: string): string {
  return `/${cleanSlug(slug)}`;
}

export class CloudflareService {
  configured(): boolean {
    const tunnelId = String(process.env.CF_TUNNEL_ID || '');
    const looksLikeToken = tunnelId.startsWith('cfut_') || tunnelId.startsWith('eyJ');
    return !!(
      process.env.CF_API_TOKEN &&
      process.env.CF_ACCOUNT_ID &&
      tunnelId &&
      !looksLikeToken
    );
  }

  async ensureConnector(): Promise<boolean> {
    const res = await serverManagerService.executeCommand({
      command:
        'docker start cloudflared >/dev/null 2>&1; docker inspect -f "{{.State.Running}}" cloudflared 2>/dev/null || echo false',
      timeout: 20000,
    });
    return /true/i.test(String(res.stdout || '').trim());
  }

  async publishApp(allSlugs: string[], catalogPaths: string[] = []): Promise<CloudflarePublishResult> {
    return this.publishRoutes(allSlugs, catalogPaths);
  }

  async publishRoutes(allSlugs: string[], catalogPaths: string[] = []): Promise<CloudflarePublishResult> {
    const running = await this.ensureConnector();
    const host = publicHostname();

    if (!this.configured()) {
      const tunnelId = String(process.env.CF_TUNNEL_ID || '');
      const misconfiguredToken =
        tunnelId.startsWith('cfut_') || tunnelId.startsWith('eyJ')
          ? ' CF_TUNNEL_ID está com token de execução; use o UUID do túnel e coloque o token em CF_TUNNEL_TOKEN.'
          : '';
      return {
        ok: running,
        message: running
          ? `Túnel ativo em ${host}. Defina CF_API_TOKEN, CF_ACCOUNT_ID e CF_TUNNEL_ID (UUID) para gravar rotas.${misconfiguredToken}`
          : `Cloudflared parado. Suba o túnel no Docker ou configure o token da API da Cloudflare.${misconfiguredToken}`,
      };
    }

    try {
      const verify = await this.verifyToken();
      if (!verify.ok) {
        return {
          ok: false,
          message: verify.message + (running ? ' (túnel Docker está no ar)' : ''),
        };
      }

      await this.rebuildIngress(allSlugs, catalogPaths);
      return {
        ok: true,
        message: 'Cloudflare atualizado',
      };
    } catch (err: any) {
      return {
        ok: false,
        message:
          (err?.message || 'Falha ao cadastrar rotas no túnel da Cloudflare') +
          (running ? ' (túnel Docker está no ar)' : ''),
      };
    }
  }

  async unpublishApp(remainingSlugs: string[], catalogPaths: string[] = []): Promise<void> {
    if (!this.configured()) return;
    await this.rebuildIngress(remainingSlugs, catalogPaths);
  }

  async repairIngress(slugs: string[] = [], catalogPaths: string[] = []): Promise<void> {
    if (!this.configured()) return;
    await this.rebuildIngress(slugs, catalogPaths);
  }

  async rebuildIngress(slugs: string[], catalogPaths: string[] = []): Promise<void> {
    if (!this.configured()) return;
    const hostname = publicHostname();
    const origin = originService();
    const pathSet = new Set<string>();
    const ingress: TunnelIngress[] = [];

    const addPath = (raw: string) => {
      const clean = cleanSlug(raw);
      if (!clean || RESERVED_PATHS.has(clean)) return;
      const pattern = pathPattern(clean);
      if (pathSet.has(pattern)) return;
      pathSet.add(pattern);
      ingress.push({ hostname, path: pattern, service: origin });
    };

    for (const path of catalogPaths) addPath(path);
    for (const slug of slugs) addPath(slug);

    ingress.sort((a, b) => (b.path?.length || 0) - (a.path?.length || 0));

    const config = await this.getConfig();
    await this.putConfig({
      ...config,
      ingress: [...ingress, { hostname, service: origin }, { service: 'http_status:404' }],
    });
  }

  private async verifyToken(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
        headers: this.headers(),
      });
      const body = (await res.json()) as any;
      if (!res.ok || body?.success === false) {
        const msg = body?.errors?.[0]?.message || `Token inválido (${res.status})`;
        return {
          ok: false,
          message: `${msg}. Gere um token com permissão "Account → Cloudflare Tunnel → Edit" em dash.cloudflare.com.`,
        };
      }
      return { ok: true, message: 'Token válido' };
    } catch (err: any) {
      return { ok: false, message: err?.message || 'Falha ao validar token da Cloudflare' };
    }
  }

  private apiBase(): string {
    const account = process.env.CF_ACCOUNT_ID;
    const tunnel = process.env.CF_TUNNEL_ID;
    return `https://api.cloudflare.com/client/v4/accounts/${account}/cfd_tunnel/${tunnel}/configurations`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    };
  }

  private async getConfig(): Promise<TunnelConfig> {
    const res = await fetch(this.apiBase(), { headers: this.headers() });
    const body = (await res.json()) as any;
    if (!res.ok || body?.success === false) {
      const raw = body?.errors?.[0]?.message || `Cloudflare GET ${res.status}`;
      const msg =
        raw === 'Not authorized'
          ? 'Token válido, mas sem acesso a este túnel. Confira CF_ACCOUNT_ID e CF_TUNNEL_ID no .env e gere um token com permissão "Account → Cloudflare Tunnel → Edit".'
          : raw;
      throw new Error(msg);
    }
    return (body?.result?.config || {}) as TunnelConfig;
  }

  private async putConfig(config: TunnelConfig): Promise<void> {
    const res = await fetch(this.apiBase(), {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ config }),
    });
    const body = (await res.json()) as any;
    if (!res.ok || body?.success === false) {
      const raw = body?.errors?.[0]?.message || `Cloudflare PUT ${res.status}`;
      const msg =
        raw === 'Not authorized'
          ? 'Token válido, mas sem permissão para editar este túnel. Atualize CF_API_TOKEN com "Account → Cloudflare Tunnel → Edit".'
          : raw;
      throw new Error(msg);
    }
  }
}

export const cloudflareService = new CloudflareService();
