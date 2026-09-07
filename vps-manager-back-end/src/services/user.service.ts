import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import {
  ScreenKey,
  AccessLevel,
  ScreenPermission,
  UserAccount,
  PublicUserAccount,
  AuthUserSession,
} from '../types';
import { wslService } from './wsl.service';
import { enqueueWrite, loadUsers, replaceUsers } from '../db/store';

const ALL_SCREENS: ScreenKey[] = [
  'dashboard',
  'terminal',
  'command',
  'services',
  'files',
  'logs',
  'appsInstalled',
  'users',
  'servers',
  'websites',
  'aplicacoes',
];

export const SCREEN_META: Record<ScreenKey, { label: string; description: string }> = {
  dashboard: { label: 'Dashboard', description: 'Visão geral do servidor, métricas e gráficos' },
  terminal: { label: 'Terminal', description: 'Acesso interativo ao terminal (bash/SSH)' },
  command: {
    label: 'Executar Comando',
    description: 'Executar comandos shell e instalar apps Linux do catálogo',
  },
  services: { label: 'Serviços (systemd)', description: 'Gerenciar serviços do Linux (start/stop/restart)' },
  files: { label: 'Arquivos', description: 'Navegar e ler arquivos no sistema de arquivos' },
  logs: { label: 'Logs', description: 'Visualizar journald, dmesg e syslog' },
  appsInstalled: { label: 'Aplicativos Instalados', description: 'Ver status e versões dos apps instalados' },
  users: { label: 'Gerenciar Usuários', description: 'Criar, editar e remover usuários e permissões' },
  servers: { label: 'Gerenciar Servidores', description: 'Adicionar, alterar e conectar servidores WSL e SSH' },
  websites: { label: 'Website', description: 'Atalhos para os seus sites e painéis web' },
  aplicacoes: { label: 'Aplicações', description: 'Upload de frontend/backend, portas e Nginx automático' },
};

function hashPassword(password: string, salt?: string): string {
  const sal = salt || randomBytes(16).toString('hex');
  const derived = scryptSync(password, sal, 64) as Buffer;
  return `${sal}:${derived.toString('hex')}`;
}

function verifyPasswordHash(password: string, stored: string): boolean {
  const [salt, hex] = String(stored || '').split(':');
  if (!salt || !hex) return false;
  try {
    const derived = scryptSync(password, salt, 64) as Buffer;
    const expected = Buffer.from(hex, 'hex');
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function genId(): string {
  return randomBytes(12).toString('hex');
}

function normalizeLinuxUsername(username: string | undefined): string | undefined {
  const clean = String(username || '').trim().replace(/^@+/, '');
  return clean ? clean : undefined;
}

function assertValidLinuxUsername(username: string): string {
  const linuxUsername = normalizeLinuxUsername(username);
  if (!linuxUsername) throw new Error('Usuário Linux inválido');
  if (linuxUsername.length > 32) {
    throw new Error('Nome de usuário Linux deve ter no máximo 32 caracteres');
  }
  if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(linuxUsername)) {
    throw new Error(
      'Nome de usuário inválido para Linux. Use letras, números, ponto, hífen ou underscore (começar com letra ou _).'
    );
  }
  return linuxUsername;
}

function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Detecta grupo de sudo (Debian/Ubuntu: sudo; RHEL: wheel). */
const SUDO_GROUP_EXPR =
  `$(getent group sudo >/dev/null 2>&1 && echo sudo || (getent group wheel >/dev/null 2>&1 && echo wheel || true))`;

export function allScreensFull(): ScreenPermission[] {
  return ALL_SCREENS.map((s) => ({ screen: s, level: 'full' as AccessLevel }));
}

export function allScreensReadOnly(): ScreenPermission[] {
  return ALL_SCREENS.filter((s) => s !== 'users').map((s) => ({
    screen: s,
    level: 'read' as AccessLevel,
  }));
}

export function operatorDefaults(): ScreenPermission[] {
  const full: ScreenKey[] = [
    'dashboard',
    'terminal',
    'command',
    'services',
    'files',
    'logs',
    'appsInstalled',
    'websites',
    'aplicacoes',
  ];
  return full.map((s) => ({ screen: s, level: 'full' as AccessLevel }));
}

export class UserService {
  private list: UserAccount[] = [];

  async reload(): Promise<void> {
    const rawUsers = await loadUsers();
    this.list = rawUsers
      .map((u) => {
        const username = String(u.username || '').trim();
        if (!username) return null;
        const role: UserAccount['role'] =
          u.role === 'admin' || u.role === 'operator' || u.role === 'viewer' ? u.role : 'viewer';
        return {
          id: u.id || genId(),
          username,
          passwordHash:
            typeof u.passwordHash === 'string' && u.passwordHash.trim()
              ? u.passwordHash
              : hashPassword(randomBytes(32).toString('hex')),
          role,
          createdAt: typeof u.createdAt === 'number' ? u.createdAt : Date.now(),
          permissions: this.normalizePerms(Array.isArray(u.permissions) ? u.permissions : [], role),
        } satisfies UserAccount;
      })
      .filter((u): u is UserAccount => !!u);

    // Root do Hub fica só no .env — remove da tabela se tiver sido criado por engano
    const envRoot = String(process.env.AUTH_USERNAME || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r/g, '')
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (envRoot) {
      const before = this.list.length;
      this.list = this.list.filter((u) => u.username.toLowerCase() !== envRoot.toLowerCase());
      if (this.list.length !== before) {
        this.persist();
        return;
      }
    }

    if (JSON.stringify(rawUsers) !== JSON.stringify(this.list)) {
      this.persist();
    }
  }

  private persist(): void {
    enqueueWrite(() => replaceUsers(this.list));
  }

  getById(id: string): UserAccount | undefined {
    return this.list.find((u) => u.id === id);
  }

  getByUsername(username: string): UserAccount | undefined {
    return this.list.find((u) => u.username.toLowerCase() === username.toLowerCase());
  }

  verifyPassword(password: string, passwordHash: string): boolean {
    return verifyPasswordHash(password, passwordHash);
  }

  ensureLinuxProfile(username: string, bootstrapAdmin = false): AuthUserSession {
    const normalized = username.trim();
    const existing = this.getByUsername(normalized);
    if (existing) return this.toSession(existing);

    const role: 'admin' | 'operator' | 'viewer' =
      bootstrapAdmin || !this.list.some((u) => u.role === 'admin') ? 'admin' : 'viewer';

    const acc: UserAccount = {
      id: genId(),
      username: normalized,
      passwordHash: hashPassword(randomBytes(32).toString('hex')),
      role,
      createdAt: Date.now(),
      permissions: role === 'admin' ? allScreensFull() : allScreensReadOnly(),
    };
    this.list.push(acc);
    this.persist();
    return this.toSession(acc);
  }

  listAll(): PublicUserAccount[] {
    return this.list.map((u) => this.toPublic(u));
  }

  toPublic(u: UserAccount): PublicUserAccount {
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      permissions: u.permissions,
    };
  }

  toSession(u: UserAccount): AuthUserSession {
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      permissions: u.permissions,
    };
  }

  create(input: {
    username: string;
    password: string;
    role?: 'admin' | 'operator' | 'viewer';
    permissions?: ScreenPermission[];
  }): PublicUserAccount {
    const username = input.username.trim();
    if (username.length < 3) throw new Error('Nome de usuário deve ter pelo menos 3 caracteres');
    if (input.password.length < 4) throw new Error('Senha deve ter pelo menos 4 caracteres');
    if (this.getByUsername(username)) throw new Error('Usuário já existe');

    const envRoot = String(process.env.AUTH_USERNAME || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r/g, '')
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (envRoot && username.toLowerCase() === envRoot.toLowerCase()) {
      throw new Error(
        `O usuário "${envRoot}" é o root do Hub (AUTH_USERNAME no .env) e não pode ser criado na página Usuários.`
      );
    }

    const role = input.role || 'viewer';
    let perms = input.permissions || [];
    if (!perms || perms.length === 0) {
      perms =
        role === 'admin'
          ? allScreensFull()
          : role === 'operator'
          ? operatorDefaults()
          : allScreensReadOnly();
    }

    const acc: UserAccount = {
      id: genId(),
      username,
      passwordHash: hashPassword(input.password),
      role,
      createdAt: Date.now(),
      permissions: this.normalizePerms(perms, role),
    };
    this.list.push(acc);
    this.persist();
    return this.toPublic(acc);
  }

  /**
   * Executa comando privilegiado: root → sudo -n → sudo -S (senha do ator).
   */
  private async runPrivilegedAs(
    rootCmd: string,
    actorUsername: string,
    actorPassword: string
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    let result = await wslService.executeCommand({
      username: 'root',
      command: rootCmd,
      timeout: 120000,
    });
    if (result.success) return result;

    result = await wslService.executeCommand({
      command: `sudo -n bash -lc ${JSON.stringify(rootCmd)}`,
      timeout: 120000,
    });
    if (result.success) return result;

    const actor = normalizeLinuxUsername(actorUsername);
    if (actorPassword && actor) {
      result = await wslService.executeCommandStdin(
        {
          username: actor,
          command: `sudo -S -p '' -k bash -lc ${JSON.stringify(rootCmd)}`,
          timeout: 120000,
        },
        `${actorPassword}\n`
      );
    }
    return result;
  }

  private failLinux(action: string, result: { stderr: string; stdout: string }): never {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 400);
    throw new Error(
      detail
        ? `Falha ao ${action} no Linux: ${detail}`
        : `Falha ao ${action} no Linux (sem privilégio root/sudo).`
    );
  }

  async createLinuxUserAs(
    actorUsername: string,
    actorPassword: string,
    newUsername: string,
    newPassword: string,
    grantSudo = false
  ): Promise<void> {
    const linuxUsername = assertValidLinuxUsername(newUsername);

    if (await wslService.linuxUserExists(linuxUsername)) {
      await this.updateLinuxPasswordAs(actorUsername, actorPassword, linuxUsername, newPassword);
      await this.setLinuxSudoAs(actorUsername, actorPassword, linuxUsername, grantSudo);
      return;
    }

    const userQ = shellSingleQuote(linuxUsername);
    const passQ = shellSingleQuote(`${linuxUsername}:${newPassword}`);
    const rootCmd = [
      `SUDO_GRP=${SUDO_GROUP_EXPR};`,
      `if [ -n "$SUDO_GRP" ] && [ ${grantSudo ? '1' : '0'} -eq 1 ]; then`,
      `  useradd -m -s /bin/bash -G "$SUDO_GRP" ${userQ};`,
      `else`,
      `  useradd -m -s /bin/bash ${userQ};`,
      `fi;`,
      `printf '%s\\n' ${passQ} | chpasswd`,
    ].join(' ');

    const result = await this.runPrivilegedAs(rootCmd, actorUsername, actorPassword);
    if (!result.success) this.failLinux(`criar usuário "${linuxUsername}"`, result);
  }

  async updateLinuxPasswordAs(
    actorUsername: string,
    actorPassword: string,
    targetUsername: string,
    newPassword: string
  ): Promise<void> {
    const linuxUsername = assertValidLinuxUsername(targetUsername);
    const rootCmd = `printf '%s\\n' ${shellSingleQuote(`${linuxUsername}:${newPassword}`)} | chpasswd`;
    const result = await this.runPrivilegedAs(rootCmd, actorUsername, actorPassword);
    if (!result.success) this.failLinux(`atualizar senha de "${linuxUsername}"`, result);
  }

  async setLinuxSudoAs(
    actorUsername: string,
    actorPassword: string,
    targetUsername: string,
    grantSudo: boolean
  ): Promise<void> {
    const linuxUsername = assertValidLinuxUsername(targetUsername);
    if (!(await wslService.linuxUserExists(linuxUsername))) {
      throw new Error(`Usuário Linux "${linuxUsername}" não existe; não foi possível ajustar sudo.`);
    }

    const userQ = shellSingleQuote(linuxUsername);
    const rootCmd = grantSudo
      ? [
          `SUDO_GRP=${SUDO_GROUP_EXPR};`,
          `if [ -z "$SUDO_GRP" ]; then echo "Grupo sudo/wheel não encontrado" >&2; exit 1; fi;`,
          `usermod -aG "$SUDO_GRP" ${userQ}`,
        ].join(' ')
      : [
          `gpasswd -d ${userQ} sudo >/dev/null 2>&1 || true;`,
          `gpasswd -d ${userQ} wheel >/dev/null 2>&1 || true;`,
          `true`,
        ].join(' ');

    const result = await this.runPrivilegedAs(rootCmd, actorUsername, actorPassword);
    if (!result.success) {
      this.failLinux(
        grantSudo ? `conceder sudo a "${linuxUsername}"` : `remover sudo de "${linuxUsername}"`,
        result
      );
    }
  }

  async deleteLinuxUserAs(
    actorUsername: string,
    actorPassword: string,
    targetUsername: string
  ): Promise<void> {
    const linuxUsername = assertValidLinuxUsername(targetUsername);
    if (!(await wslService.linuxUserExists(linuxUsername))) return;

    const rootCmd = `userdel -r ${shellSingleQuote(linuxUsername)} 2>/dev/null || userdel ${shellSingleQuote(linuxUsername)}`;
    const result = await this.runPrivilegedAs(rootCmd, actorUsername, actorPassword);
    if (!result.success) this.failLinux(`remover usuário "${linuxUsername}"`, result);
  }

  update(
    id: string,
    patch: {
      password?: string;
      role?: 'admin' | 'operator' | 'viewer';
      permissions?: ScreenPermission[];
    }
  ): PublicUserAccount {
    const u = this.list.find((x) => x.id === id);
    if (!u) throw new Error('Usuário não encontrado');

    if (patch.password !== undefined) {
      if (patch.password.length < 4) throw new Error('Senha deve ter pelo menos 4 caracteres');
      u.passwordHash = hashPassword(patch.password);
    }

    if (patch.role) u.role = patch.role;

    if (patch.permissions) {
      u.permissions = this.normalizePerms(patch.permissions, u.role);
    } else if (patch.role) {
      u.permissions =
        u.role === 'admin'
          ? allScreensFull()
          : u.role === 'operator'
          ? operatorDefaults()
          : allScreensReadOnly();
    }

    this.persist();
    return this.toPublic(u);
  }

  delete(id: string, currentUserId: string): UserAccount {
    if (id === currentUserId) throw new Error('Não pode excluir seu próprio usuário');
    const idx = this.list.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error('Usuário não encontrado');
    if (this.list.filter((u) => u.role === 'admin').length === 1 && this.list[idx].role === 'admin') {
      throw new Error('Deve existir pelo menos um usuário admin');
    }
    const [removed] = this.list.splice(idx, 1);
    this.persist();
    return removed;
  }

  private normalizePerms(
    perms: ScreenPermission[],
    role: 'admin' | 'operator' | 'viewer'
  ): ScreenPermission[] {
    if (role === 'admin') return allScreensFull();

    const map = new Map<ScreenKey, AccessLevel>();
    for (const p of perms) {
      if (!ALL_SCREENS.includes(p.screen)) continue;
      const curr = map.get(p.screen);
      if (!curr || p.level === 'full') map.set(p.screen, p.level);
    }

    if (map.get('users')) map.set('users', 'read');

    if (!map.has('websites')) {
      map.set('websites', role === 'operator' ? 'full' : 'read');
    }

    if (!map.has('aplicacoes')) {
      map.set('aplicacoes', role === 'operator' ? 'full' : 'read');
    }

    if (role === 'viewer') {
      for (const key of ['terminal', 'command', 'services'] as ScreenKey[]) {
        const v = map.get(key);
        if (v === 'full') map.set(key, 'read');
      }
    }

    return Array.from(map.entries()).map(([screen, level]) => ({ screen, level }));
  }

  canAccess(session: AuthUserSession, screen: ScreenKey, requiredLevel: AccessLevel = 'read'): boolean {
    if (session.isEnvRoot || session.role === 'admin') return true;
    const perm = session.permissions.find((p) => p.screen === screen);
    if (!perm) return false;
    if (requiredLevel === 'full') return perm.level === 'full';
    return true;
  }

  listScreensMeta(): Array<{ key: ScreenKey } & (typeof SCREEN_META)[ScreenKey]> {
    return ALL_SCREENS.map((k) => ({ key: k, ...SCREEN_META[k] }));
  }
}

export const userService = new UserService();
