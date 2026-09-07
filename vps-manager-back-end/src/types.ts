export type ScreenKey =
  | 'dashboard'
  | 'terminal'
  | 'command'
  | 'services'
  | 'files'
  | 'logs'
  | 'appsInstalled'
  | 'users'
  | 'servers'
  | 'websites'
  | 'aplicacoes';

export type AccessLevel = 'read' | 'full';

export type ServerType = 'wsl' | 'ssh' | 'local';

export interface ServerNode {
  id: string;
  name: string;
  type: ServerType;
  isDefault?: boolean;
  status?: 'online' | 'offline' | 'checking';
  description?: string;
  // WSL options
  wslDistro?: string;
  // SSH options
  host?: string;
  port?: number;
  username?: string;
  authType?: 'password' | 'key';
  password?: string;
  privateKey?: string;
  // Stats & metadata
  createdAt: number;
  lastConnectedAt?: number;
  lastError?: string;
  distro?: string;
  kernel?: string;
  uptime?: string;
}

export interface PublicServerNode {
  id: string;
  name: string;
  type: ServerType;
  isDefault?: boolean;
  isActive?: boolean;
  status?: 'online' | 'offline' | 'checking';
  description?: string;
  wslDistro?: string;
  host?: string;
  port?: number;
  username?: string;
  authType?: 'password' | 'key';
  hasPassword?: boolean;
  hasPrivateKey?: boolean;
  createdAt: number;
  lastConnectedAt?: number;
  lastError?: string;
  distro?: string;
  kernel?: string;
  uptime?: string;
}

export interface ScreenPermission {
  screen: ScreenKey;
  level: AccessLevel;
}

export interface UserAccount {
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin' | 'operator' | 'viewer';
  createdAt: number;
  permissions: ScreenPermission[];
}

export interface PublicUserAccount {
  id: string;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  createdAt: number;
  permissions: ScreenPermission[];
}

export interface AuthUserSession {
  id: string;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  permissions: ScreenPermission[];
  /** Root do Hub definido em AUTH_USERNAME / AUTH_PASSWORD no .env (não fica na tabela users). */
  isEnvRoot?: boolean;
}

export interface WslCommandRequest {
  command: string;
  username?: string;
  workingDirectory?: string;
  timeout?: number;
}

export interface WslCommandResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
  command: string;
}

export interface WslInfo {
  distro: string;
  version: string;
  state: 'Running' | 'Stopped' | string;
  kernel?: string;
  uptime?: string;
}

export interface SystemStats {
  cpuUsage: number;
  memoryUsedGB: number;
  memoryTotalGB: number;
  memoryPercent: number;
  diskUsedGB: number;
  diskTotalGB: number;
  diskPercent: number;
  runningProcesses: number;
  networkRxMB: number;
  networkTxMB: number;
}

export interface AuthCredentials {
  username: string;
  password: string;
}

export type AppCategory =
  | 'web'
  | 'containers'
  | 'database'
  | 'filemanager'
  | 'security'
  | 'monitoring'
  | 'utilities';

export interface CatalogApp {
  id: string;
  name: string;
  icon: string;
  category: AppCategory;
  description: string;
  installCommand: string;
  detectCommand: string;
  defaultPort?: number;
  docsUrl?: string;
  postInstallHint?: string;
  requiresSudo?: boolean;
  startCommand?: string;
  stopCommand?: string;
  restartCommand?: string;
  composePath?: string;
  isDocker?: boolean;
  protocol?: 'http' | 'https';
  webPath?: string;
  hasWebUi?: boolean;
  connectionString?: string;
  nginxPath?: string;
  nginxSubdomain?: string;
}

export interface InstalledApp {
  id: string;
  name: string;
  icon: string;
  category: AppCategory;
  description: string;
  installed: boolean;
  version?: string;
  running?: boolean | null;
  status?: string;
  defaultPort?: number;
  docsUrl?: string;
  postInstallHint?: string;
  startCommand?: string;
  stopCommand?: string;
  restartCommand?: string;
  composePath?: string;
  isDocker?: boolean;
  protocol?: 'http' | 'https';
  webPath?: string;
  hasWebUi?: boolean;
  connectionString?: string;
  nginxPath?: string;
  nginxSubdomain?: string;
  publicUrl?: string;
  localUrl?: string;
}

export interface WebsiteBookmark {
  id: string;
  name: string;
  url: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface HubApplication {
  id: string;
  name: string;
  slug: string;
  description?: string;
  hasFrontend: boolean;
  hasBackend: boolean;
  frontendPath?: string;
  backendPath?: string;
  backendPort?: number;
  publicPort?: number;
  frontendUrl?: string;
  backendUrl?: string;
  publicUrl?: string;
  nginxEnabled: boolean;
  nginxMessage?: string;
  cloudflareEnabled: boolean;
  cloudflareMessage?: string;
  status: 'deploying' | 'active' | 'error';
  lastError?: string;
  databaseName?: string;
  /** Réplicas do backend (1–5). >1 usa load balancer no compose. */
  replicas?: number;
  /** Limite de memória por réplica da API (MB). */
  memoryLimitMb?: number;
  /** Limite de CPU por réplica (ex.: 0.5 = meio núcleo). */
  cpuLimit?: number;
  /** Auto-scale por CPU/RAM (sobe/desce réplicas sozinho). */
  autoScaleEnabled?: boolean;
  autoScaleMin?: number;
  autoScaleMax?: number;
  /** % médio de CPU (docker stats) para subir réplica. */
  autoScaleCpuUp?: number;
  /** % médio de memória (do limite) para subir réplica. */
  autoScaleMemUp?: number;
  /** % médio de CPU para descer réplica. */
  autoScaleCpuDown?: number;
  /** % médio de memória para descer réplica. */
  autoScaleMemDown?: number;
  /** Última vez que o autoscaler alterou réplicas. */
  lastScaleAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PortAllocation {
  port: number;
  status: 'reserved' | 'allocated' | 'listening';
  appId?: string;
  appName?: string;
  role?: 'backend' | 'public' | 'system';
  process?: string;
}

export interface InstallJob {
  jobId: string;
  appId: string;
  status: 'running' | 'success' | 'error';
  startedAt: number;
  finishedAt?: number;
  output: string;
  error?: string;
}
