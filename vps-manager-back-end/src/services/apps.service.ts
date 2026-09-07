import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CatalogApp, InstalledApp, InstallJob, AppCategory } from '../types';
import { serverManagerService } from './server-manager.service';
import { wslService } from './wsl.service';
import { cloudflareService } from './cloudflare.service';
import { enqueueWrite, loadInstallJobs, pruneOldInstallJobs, upsertInstallJob } from '../db/store';
import { appendBoundedText, truncateText, MAX_JOB_OUTPUT_CHARS } from '../lib/output-buffer';

const MAX_JOBS_IN_MEMORY = 50;

const APACHE_CONF = '/opt/apache/hub.conf';
const APACHE_BACKEND_HOST = process.env.APACHE_BACKEND_HOST || '172.17.0.1';
const BEGIN_CATALOG_MARK = '# BEGIN HUB-CATALOG-APPS';
const END_CATALOG_MARK = '# END HUB-CATALOG-APPS';
const RESERVED_TUNNEL_PATHS = new Set(['api', 'health', 'ws', 'central-apps-hub', 'www']);

export function hubPublicOrigin(): string {
  return String(process.env.PUBLIC_ORIGIN || 'https://central-apps-hub.com.br').replace(/\/$/, '');
}

function toWslPath(winPath: string): string {
  if (!/^[A-Za-z]:\\/.test(winPath)) return winPath;
  const drive = winPath[0].toLowerCase();
  return `/mnt/${drive}${winPath.slice(2).replace(/\\/g, '/')}`;
}

function writeTemp(prefix: string, contents: string, ext = '.sh'): string {
  const file = path.join(os.tmpdir(), `${prefix}-${randomBytes(6).toString('hex')}${ext}`);
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

function buildAppUrls(app: CatalogApp): { publicUrl?: string; localUrl?: string } {
  if (app.hasWebUi === false) return {};

  const localProtocol =
    app.protocol ||
    (app.defaultPort === 443 || app.defaultPort === 8083 || app.defaultPort === 9090 ? 'https' : 'http');
  let localUrl: string | undefined;
  if (app.defaultPort || app.webPath) {
    const portPart =
      (localProtocol === 'http' && app.defaultPort === 80) ||
      (localProtocol === 'https' && app.defaultPort === 443)
        ? ''
        : app.defaultPort
          ? `:${app.defaultPort}`
          : '';
    const webPath = app.webPath || '/';
    localUrl = `${localProtocol}://localhost${portPart}${webPath.startsWith('/') ? webPath : `/${webPath}`}`;
  }

  const origin = hubPublicOrigin();
  let publicUrl: string | undefined;
  if (app.nginxPath) {
    publicUrl =
      app.nginxPath === '/'
        ? `${origin}/`
        : `${origin}${app.nginxPath.replace(/\/$/, '')}/`;
  } else if (app.id === 'apache') {
    publicUrl = `${origin}/`;
  }

  return { publicUrl, localUrl };
}

function persistJob(job: InstallJob): void {
  const snapshot = { ...job, output: truncateText(job.output, MAX_JOB_OUTPUT_CHARS) };
  enqueueWrite(() => upsertInstallJob(snapshot));
}

const APT_UPDATE =
  "export DEBIAN_FRONTEND=noninteractive ; (which apt-get >/dev/null && (sudo -v 2>/dev/null && sudo apt-get update -y || apt-get update -y) 2>&1 | tail -n 5 ; true)";

function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildSudoWrappedCommand(command: string, sudoPassword: string | undefined): { cmd: string; stdin: string | undefined } {
  if (!sudoPassword) return { cmd: command, stdin: undefined };

  const inner =
    `export DEBIAN_FRONTEND=noninteractive; echo SUDO_AUTH_OK; ${command}; echo DONE_INSTALL_WRAPPER`;

  // Password goes on stdin (sudo -S). The whole install runs as root so apt/systemctl work.
  const cmd =
    `export DEBIAN_FRONTEND=noninteractive; ` +
    `if [ -x /usr/bin/sudo ]; then ` +
    `/usr/bin/sudo -S -p '' -k bash -lc ${shellSingleQuote(inner)}; ` +
    `else ${command}; echo DONE_INSTALL_WRAPPER; fi`;

  return { cmd, stdin: `${sudoPassword}\n` };
}

export const APP_CATEGORIES: Array<{ key: AppCategory; label: string; emoji: string }> = [
  { key: 'web', label: 'Servidores Web e Proxy Reverso', emoji: '🌐' },
  { key: 'containers', label: 'Containers e Orquestração', emoji: '🐳' },
  { key: 'database', label: 'Bancos de Dados e Cache', emoji: '🗄️' },
  { key: 'filemanager', label: 'Gerenciadores de Arquivos e Painéis', emoji: '📂' },
  { key: 'security', label: 'Segurança e Firewall', emoji: '🔒' },
  { key: 'monitoring', label: 'Monitoramento e Saúde', emoji: '📊' },
  { key: 'utilities', label: 'Utilitários, Diagnóstico e CLI', emoji: '⚙️' },
];

export const CATALOG: CatalogApp[] = [
  // 1. WEB
  {
    id: 'nginx',
    name: 'Nginx',
    icon: '🌐',
    category: 'web',
    description: 'Servidor web ultrarrápido e proxy reverso de alta performance.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y nginx || apt-get install -y nginx)) ; which nginx ; (systemctl enable nginx 2>/dev/null ; systemctl start nginx 2>/dev/null ; service nginx start 2>/dev/null ; true) ; echo DONE_NGINX`,
    detectCommand: `which nginx && (nginx -v 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    defaultPort: 80,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    startCommand: 'systemctl start nginx 2>/dev/null || service nginx start',
    stopCommand: 'systemctl stop nginx 2>/dev/null || service nginx stop',
    restartCommand: 'systemctl restart nginx 2>/dev/null || service nginx restart',
    postInstallHint: 'Arquivos de configuração em /etc/nginx/. Acesse http://<server-ip>/ para teste.',
    requiresSudo: true,
  },
  {
    id: 'apache',
    name: 'Apache',
    icon: '🪶',
    category: 'web',
    description: 'Servidor web Apache (httpd) em Docker. Proxy reverso do hub na porta 8081.',
    installCommand: `mkdir -p /hub-apps/apache /opt/apache 2>/dev/null ; cat > /opt/apache/docker-compose.yml <<'EOF'
name: hub-apache
services:
  apache:
    image: httpd:2.4-alpine
    container_name: apache
    restart: unless-stopped
    ports:
      - "8081:80"
    volumes:
      - /hub-apps/apache:/usr/local/apache2/htdocs
    healthcheck:
      test: ["CMD-SHELL", "httpd -t"]
      interval: 30s
      timeout: 5s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 256M
EOF
(cd /opt/apache && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_APACHE`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^apache$' && (echo INSTALLED && docker ps --filter name=apache --format '{{.Status}}' 2>/dev/null | head -n 1)) || (which apache2 2>/dev/null && echo INSTALLED) || ([ -f /opt/apache/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 8081,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/',
    nginxSubdomain: 'apache.localhost',
    isDocker: true,
    composePath: '/opt/apache',
    startCommand: 'cd /opt/apache && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start apache 2>/dev/null || systemctl start apache2 2>/dev/null || service apache2 start)',
    stopCommand: 'cd /opt/apache && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop apache 2>/dev/null || systemctl stop apache2 2>/dev/null || service apache2 stop)',
    restartCommand: 'cd /opt/apache && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart apache 2>/dev/null || systemctl restart apache2 2>/dev/null || service apache2 restart)',
    postInstallHint: 'Apache escuta em http://localhost:8081/. Use a página Aplicações para publicar apps.',
    requiresSudo: true,
  },
  {
    id: 'servicos',
    name: 'Serviços (Backend)',
    icon: '⚙️',
    category: 'web',
    description: 'API Node.js de exemplo em Docker, na porta 3002.',
    installCommand: `mkdir -p /hub-apps/servicos/exemplo /opt/servicos 2>/dev/null ; cat > /hub-apps/servicos/exemplo/package.json <<'EOF'
{
  "name": "hub-apps-servicos",
  "private": true,
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": { "express": "^4.19.2", "cors": "^2.8.5" }
}
EOF
cat > /hub-apps/servicos/exemplo/server.js <<'EOF'
const express = require('express');
const cors = require('cors');
const PORT = parseInt(process.env.PORT || '3001', 10);
const app = express();
app.use(cors());
app.use(express.json());
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'hub-apps-servicos', root: '/hub-apps/servicos/exemplo' });
});
app.get('/api', (_req, res) => {
  res.json({
    message: 'Backend ativo em /hub-apps/servicos/exemplo',
    hint: 'Crie uma pasta por projeto em /hub-apps/servicos/<nome-do-projeto>.',
  });
});
app.listen(PORT, '0.0.0.0', () => {
  console.log('Servicos backend listening on ' + PORT);
});
EOF
cat > /opt/servicos/docker-compose.yml <<'EOF'
name: hub-servicos
services:
  servicos:
    image: node:20-alpine
    container_name: servicos
    restart: unless-stopped
    working_dir: /app
    ports:
      - "3002:3001"
    environment:
      PORT: "3001"
    volumes:
      - /hub-apps/servicos/exemplo:/app
    command: sh -c "npm install --omit=dev && node server.js"
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3001/health"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s
    deploy:
      resources:
        limits:
          memory: 256M
EOF
(cd /opt/servicos && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 8) ; echo DONE_SERVICOS`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^servicos$' && (echo INSTALLED && docker ps --filter name=servicos --format '{{.Status}}' 2>/dev/null | head -n 1)) || ([ -f /opt/servicos/docker-compose.yml ] && echo INSTALLED) || ([ -f /hub-apps/servicos/exemplo/server.js ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 3002,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/health',
    nginxPath: '/api',
    nginxSubdomain: 'servicos.localhost',
    isDocker: true,
    composePath: '/opt/servicos',
    startCommand: 'cd /opt/servicos && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start servicos 2>/dev/null)',
    stopCommand: 'cd /opt/servicos && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop servicos 2>/dev/null)',
    restartCommand: 'cd /opt/servicos && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart servicos 2>/dev/null)',
    postInstallHint: 'API de exemplo em http://localhost:3002/health. Para apps próprios, use a página Aplicações.',
    requiresSudo: true,
  },
  {
    id: 'caddy',
    name: 'Caddy',
    icon: '🔰',
    category: 'web',
    description: 'Servidor web moderno com HTTPS automático via Let\'s Encrypt.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl || apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl)) ; curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' 2>/dev/null | (sudo -n true 2>/dev/null && sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg || gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg) >/dev/null 2>&1 ; curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' 2>/dev/null | (sudo -n true 2>/dev/null && sudo tee /etc/apt/sources.list.d/caddy-stable.list || tee /etc/apt/sources.list.d/caddy-stable.list) >/dev/null 2>&1 ; ${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y caddy || apt-get install -y caddy)) ; which caddy ; (systemctl enable caddy 2>/dev/null ; systemctl start caddy 2>/dev/null ; service caddy start 2>/dev/null ; true) ; echo DONE_CADDY`,
    detectCommand: `which caddy && (caddy version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    defaultPort: 80,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    startCommand: 'systemctl start caddy 2>/dev/null || service caddy start',
    stopCommand: 'systemctl stop caddy 2>/dev/null || service caddy stop',
    restartCommand: 'systemctl restart caddy 2>/dev/null || service caddy restart',
    postInstallHint: 'Arquivo Caddyfile em /etc/caddy/. Caddy emite certificado SSL automaticamente.',
    requiresSudo: true,
  },
  // 2. CONTAINERS
  {
    id: 'docker',
    name: 'Docker',
    icon: '🐳',
    category: 'containers',
    description: 'Plataforma essencial para isolar e gerenciar aplicações em containers.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y ca-certificates curl gnupg lsb-release || apt-get install -y ca-certificates curl gnupg lsb-release)) ; (mkdir -p /etc/apt/keyrings 2>/dev/null ; curl -fsSL https://download.docker.com/linux/ubuntu/gpg 2>/dev/null | (sudo -n true 2>/dev/null && sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg || gpg --dearmor -o /etc/apt/keyrings/docker.gpg) >/dev/null 2>&1 ; true) ; (echo "deb [arch=$(dpkg --print-architecture 2>/dev/null || echo amd64) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs 2>/dev/null || echo jammy) stable" 2>/dev/null | (sudo -n true 2>/dev/null && sudo tee /etc/apt/sources.list.d/docker.list || tee /etc/apt/sources.list.d/docker.list) >/dev/null 2>&1 ; true) ; ${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)) ; which docker ; (systemctl enable docker 2>/dev/null ; systemctl start docker 2>/dev/null ; service docker start 2>/dev/null ; true) ; echo DONE_DOCKER`,
    detectCommand: `which docker && (docker --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    defaultPort: 2375,
    isDocker: true,
    hasWebUi: false,
    startCommand: 'systemctl start docker 2>/dev/null || service docker start',
    stopCommand: 'systemctl stop docker 2>/dev/null || service docker stop',
    restartCommand: 'systemctl restart docker 2>/dev/null || service docker restart',
    postInstallHint: 'Rode `docker run hello-world` para testar. Adicione seu usuário ao grupo docker para não precisar de sudo.',
    requiresSudo: true,
  },
  {
    id: 'portainer',
    name: 'Portainer',
    icon: '🛳️',
    category: 'containers',
    description: 'Interface web amigável para gerenciar containers Docker de forma visual.',
    installCommand: `${APT_UPDATE} ; (docker volume create portainer_data 2>&1 || true) ; docker run -d -p 9000:9000 --name portainer --restart=unless-stopped --memory=256m --memory-swap=256m -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data portainer/portainer-ce:2.21.4 2>&1 | tail -n 3 ; echo DONE_PORTAINER`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^portainer$' && (echo INSTALLED && docker port portainer 2>/dev/null | head -n 1)) || echo NOT_INSTALLED`,
    defaultPort: 9000,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/portainer',
    nginxSubdomain: 'portainer.localhost',
    isDocker: true,
    composePath: '/opt/portainer',
    startCommand: 'docker start portainer 2>/dev/null || docker run -d -p 9000:9000 --name portainer --restart=unless-stopped --memory=256m --memory-swap=256m -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data portainer/portainer-ce:2.21.4',
    stopCommand: 'docker stop portainer',
    restartCommand: 'docker restart portainer',
    postInstallHint: 'Acesse http://localhost:9000 ou pelo proxy em /portainer/.',
    requiresSudo: true,
  },
  {
    id: 'docker-compose',
    name: 'Docker Compose',
    icon: '🧩',
    category: 'containers',
    description: 'Ferramenta para definir e rodar aplicações Docker multi-container.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y docker-compose-plugin docker-compose || apt-get install -y docker-compose-plugin docker-compose)) ; (which docker-compose || which docker) ; echo DONE_COMPOSE`,
    detectCommand: `(which docker-compose 2>/dev/null && docker-compose --version 2>&1 | head -n 1) || (which docker 2>/dev/null && docker compose version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    isDocker: true,
    hasWebUi: false,
    postInstallHint: 'Use `docker compose up -d` na pasta com docker-compose.yml.',
    requiresSudo: true,
  },
  // 3. DATABASES
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    icon: '🐘',
    category: 'database',
    description: 'Banco relacional avançado, poderoso e altamente escalável.',
    installCommand: `mkdir -p /opt/postgres 2>/dev/null ; cat > /opt/postgres/docker-compose.yml <<'EOF'
services:
  postgres:
    image: postgres:16-alpine
    container_name: postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: postgres
    ports:
      - "5433:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 128M

volumes:
  postgres_data:
    name: postgres_postgres_data
EOF
(cd /opt/postgres && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_PG`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^postgres$' && (echo INSTALLED && docker ps --filter name=postgres --format '{{.Status}}' 2>/dev/null | head -n 1)) || (which psql 2>/dev/null && echo INSTALLED) || ([ -f /opt/postgres/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 5433,
    hasWebUi: false,
    connectionString: 'postgresql://postgres:postgres@localhost:5433/postgres',
    isDocker: true,
    composePath: '/opt/postgres',
    startCommand: 'cd /opt/postgres && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start postgres 2>/dev/null || systemctl start postgresql 2>/dev/null || service postgresql start)',
    stopCommand: 'cd /opt/postgres && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop postgres 2>/dev/null || systemctl stop postgresql 2>/dev/null || service postgresql stop)',
    restartCommand: 'cd /opt/postgres && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart postgres 2>/dev/null || systemctl restart postgresql 2>/dev/null || service postgresql restart)',
    postInstallHint: 'PostgreSQL rodando no Docker. Host: localhost, Porta: 5433, Usuário: postgres, Senha: postgres, Banco: postgres.',
    requiresSudo: true,
  },
  {
    id: 'pgadmin',
    name: 'pgAdmin 4',
    icon: '🐘',
    category: 'database',
    description: 'Interface web oficial, moderna e completa para gerenciar bancos PostgreSQL visualmente.',
    installCommand: `mkdir -p /opt/pgadmin 2>/dev/null ; cat > /opt/pgadmin/docker-compose.yml <<'EOF'
name: hub-pgadmin
services:
  pgadmin:
    image: dpage/pgadmin4:8.14
    container_name: pgadmin
    restart: unless-stopped
    mem_limit: 384m
    environment:
      PGADMIN_DEFAULT_EMAIL: admin@admin.com
      PGADMIN_DEFAULT_PASSWORD: admin
      PGADMIN_LISTEN_PORT: 80
      SCRIPT_NAME: /pgadmin
    ports:
      - "5050:80"
    volumes:
      - pgadmin_data:/var/lib/pgadmin
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:80/misc/ping"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 40s
    deploy:
      resources:
        limits:
          memory: 384M

volumes:
  pgadmin_data:
EOF
(cd /opt/pgadmin && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; docker update --memory=384m --memory-swap=384m pgadmin 2>/dev/null || true ; docker network connect postgres_default pgadmin 2>/dev/null || docker network connect hub-postgres_default pgadmin 2>/dev/null || true ; echo DONE_PGADMIN`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^pgadmin$' && (echo INSTALLED && docker ps --filter name=pgadmin --format '{{.Status}}' 2>/dev/null | head -n 1)) || ([ -f /opt/pgadmin/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 5050,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/pgadmin',
    nginxSubdomain: 'pgadmin.localhost',
    isDocker: true,
    composePath: '/opt/pgadmin',
    startCommand: 'cd /opt/pgadmin && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start pgadmin 2>/dev/null)',
    stopCommand: 'cd /opt/pgadmin && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop pgadmin 2>/dev/null)',
    restartCommand: 'cd /opt/pgadmin && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart pgadmin 2>/dev/null)',
    postInstallHint: 'pgAdmin 4 web rodando na porta 5050. Login: admin@admin.com | Senha: admin. Para conectar no PostgreSQL use Host: postgres (ou localhost), porta: 5433, usuário: postgres, senha: postgres.',
    requiresSudo: true,
  },
  {
    id: 'mariadb',
    name: 'MySQL / MariaDB',
    icon: '🐬',
    category: 'database',
    description: 'Banco relacional mais popular do ecossistema web.',
    installCommand: `mkdir -p /opt/mariadb 2>/dev/null ; cat > /opt/mariadb/docker-compose.yml <<'EOF'
name: hub-mariadb
services:
  mariadb:
    image: mariadb:11.4
    container_name: mariadb
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: root
      MARIADB_DATABASE: app
      MARIADB_USER: user
      MARIADB_PASSWORD: password
    ports:
      - "3306:3306"
    volumes:
      - mariadb_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s
    deploy:
      resources:
        limits:
          memory: 512M

volumes:
  mariadb_data:
EOF
(cd /opt/mariadb && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_MDB`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^mariadb$' && (echo INSTALLED && docker ps --filter name=mariadb --format '{{.Status}}' 2>/dev/null | head -n 1)) || (which mariadb 2>/dev/null && echo INSTALLED) || (which mysql 2>/dev/null && echo INSTALLED) || ([ -f /opt/mariadb/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 3306,
    hasWebUi: false,
    connectionString: 'mysql://user:password@localhost:3306/app',
    isDocker: true,
    composePath: '/opt/mariadb',
    startCommand: 'cd /opt/mariadb && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start mariadb 2>/dev/null || systemctl start mariadb 2>/dev/null || service mariadb start)',
    stopCommand: 'cd /opt/mariadb && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop mariadb 2>/dev/null || systemctl stop mariadb 2>/dev/null || service mariadb stop)',
    restartCommand: 'cd /opt/mariadb && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart mariadb 2>/dev/null || systemctl restart mariadb 2>/dev/null || service mariadb restart)',
    postInstallHint: 'MariaDB rodando no Docker. Porta 3306. Root password: root, Banco: app, Usuário: user, Senha: password.',
    requiresSudo: true,
  },
  {
    id: 'redis',
    name: 'Redis',
    icon: '🔴',
    category: 'database',
    description: 'Banco em memória chave-valor para cache ultrarrápido e filas.',
    installCommand: `mkdir -p /opt/redis 2>/dev/null ; cat > /opt/redis/docker-compose.yml <<'EOF'
name: hub-redis
services:
  redis:
    image: redis:7-alpine
    container_name: redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 128M

volumes:
  redis_data:
EOF
(cd /opt/redis && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_REDIS`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^redis$' && (echo INSTALLED && docker ps --filter name=redis --format '{{.Status}}' 2>/dev/null | head -n 1)) || (which redis-server 2>/dev/null && echo INSTALLED) || ([ -f /opt/redis/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 6379,
    hasWebUi: false,
    connectionString: 'redis://localhost:6379',
    isDocker: true,
    composePath: '/opt/redis',
    startCommand: 'cd /opt/redis && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start redis 2>/dev/null || systemctl start redis-server 2>/dev/null || service redis-server start)',
    stopCommand: 'cd /opt/redis && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop redis 2>/dev/null || systemctl stop redis-server 2>/dev/null || service redis-server stop)',
    restartCommand: 'cd /opt/redis && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart redis 2>/dev/null || systemctl restart redis-server 2>/dev/null || service redis-server restart)',
    postInstallHint: 'Redis rodando no Docker na porta 6379. Teste com `docker exec -it redis redis-cli ping` → PONG.',
    requiresSudo: true,
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    icon: '🍃',
    category: 'database',
    description: 'Banco NoSQL orientado a documentos para dados flexíveis.',
    installCommand: `mkdir -p /opt/mongodb 2>/dev/null ; cat > /opt/mongodb/docker-compose.yml <<'EOF'
name: hub-mongodb
services:
  mongodb:
    image: mongo:7.0
    container_name: mongodb
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: root
      MONGO_INITDB_ROOT_PASSWORD: rootpassword
    ports:
      - "27017:27017"
    volumes:
      - mongodb_data:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping').ok"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s
    deploy:
      resources:
        limits:
          memory: 512M

volumes:
  mongodb_data:
EOF
(cd /opt/mongodb && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_MONGO`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^mongodb$' && (echo INSTALLED && docker ps --filter name=mongodb --format '{{.Status}}' 2>/dev/null | head -n 1)) || (which mongod 2>/dev/null && echo INSTALLED) || ([ -f /opt/mongodb/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 27017,
    hasWebUi: false,
    connectionString: 'mongodb://root:rootpassword@localhost:27017',
    isDocker: true,
    composePath: '/opt/mongodb',
    startCommand: 'cd /opt/mongodb && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start mongodb 2>/dev/null || systemctl start mongod 2>/dev/null || service mongod start)',
    stopCommand: 'cd /opt/mongodb && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop mongodb 2>/dev/null || systemctl stop mongod 2>/dev/null || service mongod stop)',
    restartCommand: 'cd /opt/mongodb && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart mongodb 2>/dev/null || systemctl restart mongod 2>/dev/null || service mongod restart)',
    postInstallHint: 'MongoDB rodando no Docker na porta 27017. Usuário: root, Senha: rootpassword.',
    requiresSudo: true,
  },
  // 4. FILEMANAGER / PAINEIS
  {
    id: 'filegator',
    name: 'FileGator',
    icon: '📁',
    category: 'filemanager',
    description: 'Gerenciador de arquivos web leve para uploads, edições e downloads.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y php-cli php-zip php-xml unzip curl || apt-get install -y php-cli php-zip php-xml unzip curl)) ; (mkdir -p /opt/filegator 2>/dev/null ; cd /tmp && curl -fsSL https://github.com/filegator/filegator/releases/latest/download/filegator.zip -o filegator.zip 2>/dev/null && (sudo -n true 2>/dev/null && sudo unzip -oq filegator.zip -d /opt/filegator || unzip -oq filegator.zip -d /opt/filegator) && rm -f filegator.zip ; true) ; (which php && cd /opt/filegator && ls -la repository/ 2>/dev/null | head -n 2 ; true) ; echo DONE_FILEGATOR`,
    detectCommand: `([ -d /opt/filegator ] && echo "INSTALLED in /opt/filegator") || echo NOT_INSTALLED`,
    defaultPort: 8088,
    protocol: 'http',
    webPath: '/',
    composePath: '/opt/filegator',
    startCommand: 'cd /opt/filegator && (nohup php -S 0.0.0.0:8088 -t public >/dev/null 2>&1 &)',
    stopCommand: 'pkill -f "php -S 0.0.0.0:8088" || true',
    restartCommand: 'pkill -f "php -S 0.0.0.0:8088" || true ; sleep 1 ; cd /opt/filegator && (nohup php -S 0.0.0.0:8088 -t public >/dev/null 2>&1 &)',
    postInstallHint: 'Teste rápido: cd /opt/filegator && php -S 0.0.0.0:8088 -t public → acesse porta 8088. Usuário padrão admin/admin123.',
    requiresSudo: true,
  },
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    icon: '☁️',
    category: 'filemanager',
    description: 'Solução completa de nuvem privada para armazenamento e colaboração.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y apache2 mariadb-server libapache2-mod-php php-gd php-mysql php-curl php-json php-cgi php-mbstring php-intl php-imagick php-xml php-zip php-bz2 wget unzip curl || apt-get install -y apache2 mariadb-server libapache2-mod-php php-gd php-mysql php-curl php-json php-cgi php-mbstring php-intl php-imagick php-xml php-zip php-bz2 wget unzip curl)) ; (cd /tmp && wget -q https://download.nextcloud.com/server/releases/latest.zip -O nextcloud.zip 2>&1 | tail -n 2 ; sudo -n true 2>/dev/null && sudo unzip -oq nextcloud.zip -d /var/www/ || unzip -oq nextcloud.zip -d /var/www/ ; rm -f nextcloud.zip ; sudo -n true 2>/dev/null && sudo chown -R www-data:www-data /var/www/nextcloud || chown -R www-data:www-data /var/www/nextcloud ; true) ; (a2enmod rewrite 2>/dev/null ; systemctl restart apache2 2>/dev/null ; service apache2 restart 2>/dev/null ; true) ; echo DONE_NCLOUD`,
    detectCommand: `([ -d /var/www/nextcloud ] && echo "INSTALLED in /var/www/nextcloud") || echo NOT_INSTALLED`,
    defaultPort: 80,
    protocol: 'http',
    webPath: '/nextcloud',
    startCommand: 'systemctl start apache2 2>/dev/null || service apache2 start',
    stopCommand: 'systemctl stop apache2 2>/dev/null || service apache2 stop',
    restartCommand: 'systemctl restart apache2 2>/dev/null || service apache2 restart',
    postInstallHint: 'Acesse http://<server-ip>/nextcloud para finalizar instalação. Crie banco mariadb nextcloud antes.',
    requiresSudo: true,
  },
  {
    id: 'hestiacp',
    name: 'HestiaCP',
    icon: '🖥️',
    category: 'filemanager',
    description: 'Painel de controle completo para gerenciar sites, domínios, bancos e e-mails.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y curl ca-certificates || apt-get install -y curl ca-certificates)) ; (cd /tmp && curl -fsSL https://raw.githubusercontent.com/hestiacp/hestiacp/release/install/hst-install.sh -o hst-install.sh 2>/dev/null && chmod +x hst-install.sh ; echo "Run manually: bash /tmp/hst-install.sh --interactive no --email admin@localhost --password ChangeMe123 --hostname srv.local --lang pt-BR --force 2>&1 | tail -n 20") ; echo DONE_HSTIA`,
    detectCommand: `([ -f /usr/local/hestia/bin/v-list-sys-info ] && echo "INSTALLED /usr/local/hestia") || echo NOT_INSTALLED`,
    defaultPort: 8083,
    protocol: 'https',
    webPath: '/',
    startCommand: 'systemctl start hestia 2>/dev/null || service hestia start',
    stopCommand: 'systemctl stop hestia 2>/dev/null || service hestia stop',
    restartCommand: 'systemctl restart hestia 2>/dev/null || service hestia restart',
    postInstallHint: 'Rode manualmente o script em /tmp/hst-install.sh com suas opções. Painel na porta 8083 HTTPS.',
    requiresSudo: true,
  },
  {
    id: 'cockpit',
    name: 'Cockpit',
    icon: '🛠️',
    category: 'filemanager',
    description: 'Painel oficial do Linux para serviços, armazenamento e rede via navegador.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y cockpit cockpit-podman || apt-get install -y cockpit cockpit-podman)) ; (systemctl enable --now cockpit.socket 2>/dev/null ; service cockpit start 2>/dev/null ; true) ; which cockpit-bridge || true ; echo DONE_COCKPIT`,
    detectCommand: `(dpkg -l 2>/dev/null | grep -q cockpit && cockpit-bridge --version 2>&1 | head -n 1) || ([ -f /etc/cockpit/cockpit.conf ] && echo "INSTALLED") || echo NOT_INSTALLED`,
    defaultPort: 9090,
    protocol: 'https',
    webPath: '/',
    startCommand: 'systemctl start cockpit.socket 2>/dev/null || service cockpit start',
    stopCommand: 'systemctl stop cockpit.socket 2>/dev/null || service cockpit stop',
    restartCommand: 'systemctl restart cockpit.socket 2>/dev/null || service cockpit restart',
    postInstallHint: 'Acesse https://<server-ip>:9090 com usuário/senha do Linux.',
    requiresSudo: true,
  },
  // 5. SEGURANÇA
  {
    id: 'ufw',
    name: 'UFW Firewall',
    icon: '🧱',
    category: 'security',
    description: 'Ferramenta simples para gerenciar regras de portas e tráfego de rede.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y ufw || apt-get install -y ufw)) ; which ufw ; (sudo -n true 2>/dev/null && (sudo ufw allow 22/tcp ; sudo ufw allow 80/tcp ; sudo ufw allow 443/tcp ; echo "y" | sudo ufw enable 2>&1) ; true) ; ufw status 2>&1 | head -n 5 ; echo DONE_UFW`,
    detectCommand: `which ufw && (ufw --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    startCommand: 'echo "y" | ufw enable',
    stopCommand: 'ufw disable',
    restartCommand: 'ufw reload',
    postInstallHint: 'Permita portas com `ufw allow 80` antes de habilitar. Regras em /etc/ufw/.',
    requiresSudo: true,
  },
  {
    id: 'fail2ban',
    name: 'Fail2ban',
    icon: '🚫',
    category: 'security',
    description: 'Protege o servidor contra ataques de força bruta bloqueando IPs suspeitos.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y fail2ban || apt-get install -y fail2ban)) ; which fail2ban-client ; (systemctl enable fail2ban 2>/dev/null ; systemctl start fail2ban 2>/dev/null ; service fail2ban start 2>/dev/null ; true) ; (fail2ban-client status 2>&1 | head -n 3 || true) ; echo DONE_F2B`,
    detectCommand: `which fail2ban-client && (fail2ban-client --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    startCommand: 'systemctl start fail2ban 2>/dev/null || service fail2ban start',
    stopCommand: 'systemctl stop fail2ban 2>/dev/null || service fail2ban stop',
    restartCommand: 'systemctl restart fail2ban 2>/dev/null || service fail2ban restart',
    postInstallHint: 'Jails em /etc/fail2ban/jail.d/. Verifique status com `fail2ban-client status sshd`.',
    requiresSudo: true,
  },
  {
    id: 'certbot',
    name: 'Certbot (Let\'s Encrypt)',
    icon: '🔐',
    category: 'security',
    description: 'Utilitário oficial para emitir certificados SSL gratuitos.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y certbot python3-certbot-nginx python3-certbot-apache || apt-get install -y certbot python3-certbot-nginx python3-certbot-apache)) ; which certbot ; certbot --version 2>&1 | head -n 1 ; echo DONE_CB`,
    detectCommand: `which certbot && (certbot --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    postInstallHint: 'Obtenha cert com `certbot --nginx -d seudominio.com`. Renovação automática já vem ativada.',
    requiresSudo: true,
  },
  {
    id: 'authelia',
    name: 'Authelia (SSO)',
    icon: '🛡️',
    category: 'security',
    description: 'Autenticação avançada e 2FA para proteger suas aplicações web.',
    installCommand: `(which docker >/dev/null && docker run --rm authelia/authelia:latest authelia --version 2>&1 | head -n 1 && echo DONE_AUTHELIA_INSTALL) || (echo "Docker nao detectado. Instalando docker primeiro..."; echo "Instale o Docker antes do Authelia."; exit 1) ; mkdir -p /opt/authelia/config 2>/dev/null ; cat > /opt/authelia/config/configuration.yml <<'EOF'\ntheme: dark\njwt_secret: authelia_seed_change_me\ndefault_redirection_url: https://auth.example.com\ntotp:\n  issuer: WSL-Manager\naccess_control:\n  default_policy: deny\n  rules:\n    - domain: '*.example.com'\n      policy: bypass\nsession:\n  secret: insecure_session_secret_me\n  cookies:\n    - domain: example.com\n      authelia_url: https://auth.example.com\n      session: authelia_session\nstorage:\n  encryption_key: you_must_generate_a_random_string_of_more_than_twenty_chars_and_configure_this\n  local:\n    path: /config/db.sqlite3\nnotification:\n  filesystem:\n    filename: /config/notification.txt\nauthentication_backend:\n  file:\n    path: /config/users_database.yml\nEOF\ncat > /opt/authelia/config/users_database.yml <<'EOF'\nusers:\n  admin:\n    disabled: false\n    displayname: Admin\n    password: \\$6\\$rounds=500000\\$salt8chars\\$hash.replace.me\n    email: admin@localhost\n    groups:\n      - admins\n      - dev\nEOF\necho "DONE_AUTHELIA"`,
    detectCommand: `([ -d /opt/authelia ] && echo "INSTALLED /opt/authelia") || (which docker >/dev/null && docker images authelia/authelia 2>/dev/null | tail -n +2 | grep -q . && echo "Docker image available") || echo NOT_INSTALLED`,
    defaultPort: 9091,
    protocol: 'http',
    webPath: '/',
    isDocker: true,
    composePath: '/opt/authelia',
    startCommand: 'cd /opt/authelia && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null)',
    stopCommand: 'cd /opt/authelia && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null)',
    restartCommand: 'cd /opt/authelia && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null)',
    postInstallHint: 'Edite configuration.yml e gere hash: `docker run --rm authelia/authelia:latest authelia crypto hash generate password`.',
    requiresSudo: true,
  },
  // 6. MONITORAMENTO
  {
    id: 'netdata',
    name: 'Netdata',
    icon: '📈',
    category: 'monitoring',
    description: 'Monitoramento em tempo real com painel web interativo e leve.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y curl || apt-get install -y curl)) ; (curl -fsSL https://get.netdata.cloud/kickstart.sh 2>/dev/null | sh -s -- --stable-channel --disable-telemetry --non-interactive 2>&1 | tail -n 15 ; true) ; (systemctl enable netdata 2>/dev/null ; systemctl start netdata 2>/dev/null ; service netdata start 2>/dev/null ; true) ; which netdata || true ; echo DONE_ND`,
    detectCommand: `(which netdata 2>/dev/null && netdata -v 2>&1 | head -n 1) || (dpkg -l 2>/dev/null | grep -q netdata && echo "INSTALLED") || echo NOT_INSTALLED`,
    defaultPort: 19999,
    protocol: 'http',
    webPath: '/',
    startCommand: 'systemctl start netdata 2>/dev/null || service netdata start',
    stopCommand: 'systemctl stop netdata 2>/dev/null || service netdata stop',
    restartCommand: 'systemctl restart netdata 2>/dev/null || service netdata restart',
    postInstallHint: 'Acesse http://<server-ip>:19999. Por padrão só aceita conexões locais — edite /etc/netdata/netdata.conf bind to = *.',
    requiresSudo: true,
  },
  {
    id: 'glances',
    name: 'Glances',
    icon: '👁️',
    category: 'monitoring',
    description: 'Monitor de sistema avançado que mostra tudo em uma única tela.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y glances python3-bottle || apt-get install -y glances python3-bottle)) ; which glances ; glances --version 2>&1 | head -n 1 ; echo DONE_GLANCES`,
    detectCommand: `which glances && (glances --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    defaultPort: 61208,
    protocol: 'http',
    webPath: '/',
    startCommand: 'nohup glances -w >/dev/null 2>&1 &',
    stopCommand: 'pkill -f "glances -w" || true',
    restartCommand: 'pkill -f "glances -w" || true ; sleep 1 ; nohup glances -w >/dev/null 2>&1 &',
    postInstallHint: 'Rodar web: `glances -w` → acesse http://<server-ip>:61208',
    requiresSudo: false,
  },
  {
    id: 'zabbix',
    name: 'Zabbix',
    icon: '🧿',
    category: 'monitoring',
    description: 'Sistema robusto de monitoramento de infraestrutura.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y wget curl ca-certificates gnupg lsb-release || apt-get install -y wget curl ca-certificates gnupg lsb-release)) ; REL=$(lsb_release -cs 2>/dev/null || echo jammy) ; (wget -q "https://repo.zabbix.com/zabbix/7.0/ubuntu/pool/main/z/zabbix-release/zabbix-release_7.0-2+ubuntu22.04_all.deb" -O /tmp/zabbix-rel.deb 2>&1 | tail -n 2 ; (sudo -n true 2>/dev/null && sudo dpkg -i /tmp/zabbix-rel.deb || dpkg -i /tmp/zabbix-rel.deb) 2>&1 | tail -n 3 ; rm -f /tmp/zabbix-rel.deb ; true) ; ${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y zabbix-server-pgsql zabbix-frontend-php php8.1-pgsql zabbix-nginx-conf zabbix-sql-scripts zabbix-agent 2>/dev/null || apt-get install -y zabbix-server-pgsql zabbix-frontend-php php8.1-pgsql zabbix-nginx-conf zabbix-sql-scripts zabbix-agent 2>/dev/null) ; true) ; echo DONE_ZBX`,
    detectCommand: `([ -f /usr/sbin/zabbix_server ] && /usr/sbin/zabbix_server -V 2>&1 | head -n 1) || (dpkg -l 2>/dev/null | grep -q zabbix && echo "INSTALLED") || echo NOT_INSTALLED`,
    defaultPort: 10051,
    startCommand: 'systemctl start zabbix-server 2>/dev/null || service zabbix-server start',
    stopCommand: 'systemctl stop zabbix-server 2>/dev/null || service zabbix-server stop',
    restartCommand: 'systemctl restart zabbix-server 2>/dev/null || service zabbix-server restart',
    postInstallHint: 'Cria banco PostgreSQL zabbix, importa schema em /usr/share/zabbix-sql-scripts/postgresql/, edita /etc/zabbix/zabbix_server.conf.',
    requiresSudo: true,
  },
  {
    id: 'prometheus-grafana',
    name: 'Prometheus + Grafana',
    icon: '📉',
    category: 'monitoring',
    description: 'Dupla poderosa para métricas e dashboards visuais.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y curl apt-transport-https software-properties-common gnupg || apt-get install -y curl apt-transport-https software-properties-common gnupg)) ; mkdir -p /opt/prom-grafana 2>/dev/null ; cat > /opt/prom-grafana/docker-compose.yml <<'EOF'\nname: hub-prom-grafana\nservices:\n  prometheus:\n    image: prom/prometheus:v2.55.1\n    container_name: prometheus\n    restart: unless-stopped\n    ports:\n      - \"9090:9090\"\n    volumes:\n      - prom_data:/prometheus\n    command:\n      - '--config.file=/etc/prometheus/prometheus.yml'\n      - '--storage.tsdb.path=/prometheus'\n    healthcheck:\n      test: [\"CMD\", \"wget\", \"-q\", \"-O\", \"/dev/null\", \"http://127.0.0.1:9090/-/healthy\"]\n      interval: 30s\n      timeout: 5s\n      retries: 3\n    deploy:\n      resources:\n        limits:\n          memory: 384M\n  grafana:\n    image: grafana/grafana:11.3.1\n    container_name: grafana\n    restart: unless-stopped\n    ports:\n      - \"3000:3000\"\n    volumes:\n      - grafana_data:/var/lib/grafana\n    healthcheck:\n      test: [\"CMD\", \"wget\", \"-q\", \"-O\", \"/dev/null\", \"http://127.0.0.1:3000/api/health\"]\n      interval: 30s\n      timeout: 5s\n      retries: 3\n    deploy:\n      resources:\n        limits:\n          memory: 256M\nvolumes:\n  prom_data:\n  grafana_data:\nEOF\nif which docker >/dev/null; then\n  (cd /opt/prom-grafana && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5)\nelse\n  echo \"Docker nao detectado, compose salvo em /opt/prom-grafana\"\nfi\necho DONE_PG`,
    detectCommand: `(which docker >/dev/null && docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'prometheus|grafana' | head -n 2 && echo "INSTALLED") || ([ -f /opt/prom-grafana/docker-compose.yml ] && echo "Config ready in /opt/prom-grafana") || echo NOT_INSTALLED`,
    defaultPort: 3000,
    protocol: 'http',
    webPath: '/',
    isDocker: true,
    composePath: '/opt/prom-grafana',
    startCommand: 'cd /opt/prom-grafana && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null)',
    stopCommand: 'cd /opt/prom-grafana && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null)',
    restartCommand: 'cd /opt/prom-grafana && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null)',
    postInstallHint: 'Grafana → http://<server-ip>:3000 (admin/admin). Prometheus → http://<server-ip>:9090',
    requiresSudo: false,
  },
  // 7. UTILITÁRIOS
  {
    id: 'btop',
    name: 'htop / btop',
    icon: '📟',
    category: 'utilities',
    description: 'Monitores de recursos interativos e coloridos para terminal.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y htop btop || apt-get install -y htop btop)) ; echo "htop: $(which htop 2>/dev/null)" ; echo "btop: $(which btop 2>/dev/null)" ; echo DONE_HTOP`,
    detectCommand: `(which btop 2>/dev/null && btop --version 2>&1 | head -n 1) || (which htop 2>/dev/null && htop --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    requiresSudo: false,
  },
  {
    id: 'tmux',
    name: 'Tmux',
    icon: '🔀',
    category: 'utilities',
    description: 'Multiplexador de terminal — sessões ativas mesmo se a conexão cair.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y tmux || apt-get install -y tmux)) ; which tmux ; tmux -V 2>&1 ; echo DONE_TMUX`,
    detectCommand: `which tmux && (tmux -V 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    requiresSudo: false,
  },
  {
    id: 'curl-wget',
    name: 'Curl / Wget',
    icon: '🔗',
    category: 'utilities',
    description: 'Essenciais para transferir dados e testar requisições HTTP via CLI.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y curl wget || apt-get install -y curl wget)) ; echo "curl: $(which curl 2>/dev/null)  $(curl --version 2>/dev/null | head -n 1)" ; echo "wget: $(which wget 2>/dev/null)  $(wget --version 2>/dev/null | head -n 1)" ; echo DONE_CW`,
    detectCommand: `(which curl || which wget) && ((curl --version 2>/dev/null | head -n 1) || (wget --version 2>/dev/null | head -n 1)) || echo NOT_INSTALLED`,
    requiresSudo: false,
  },
  {
    id: 'rsync',
    name: 'Rsync',
    icon: '🗂️',
    category: 'utilities',
    description: 'Rápido e seguro para sincronização, espelhamento e backup de arquivos.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y rsync || apt-get install -y rsync)) ; which rsync ; rsync --version 2>&1 | head -n 1 ; echo DONE_RSYNC`,
    detectCommand: `which rsync && (rsync --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    requiresSudo: false,
  },
  {
    id: 'git',
    name: 'Git',
    icon: '🌿',
    category: 'utilities',
    description: 'Controle de versão para implantar códigos diretamente no servidor.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y git || apt-get install -y git)) ; which git ; git --version 2>&1 ; echo DONE_GIT`,
    detectCommand: `which git && (git --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    requiresSudo: false,
  },
  {
    id: 'pm2',
    name: 'PM2',
    icon: '♾️',
    category: 'utilities',
    description: 'Gerenciador de processos robusto para apps Node.js em background.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y nodejs npm || apt-get install -y nodejs npm)) ; (which npm >/dev/null && (sudo -n true 2>/dev/null && sudo npm install -g pm2 || npm install -g pm2) 2>&1 | tail -n 5 ; which pm2 ; pm2 --version 2>&1 ; true) ; echo DONE_PM2`,
    detectCommand: `which pm2 && (pm2 --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    startCommand: 'pm2 resurrect 2>/dev/null || pm2 start all 2>/dev/null',
    stopCommand: 'pm2 stop all 2>/dev/null',
    restartCommand: 'pm2 restart all 2>/dev/null',
    postInstallHint: 'Inicie apps: `pm2 start index.js --name minhaapp`. Salve: `pm2 save` + `pm2 startup`.',
    requiresSudo: true,
  },
  {
    id: 'logrotate',
    name: 'Logrotate',
    icon: '🪵',
    category: 'utilities',
    description: 'Automatiza rotação, compressão e limpeza de logs do sistema.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y logrotate || apt-get install -y logrotate)) ; which logrotate ; logrotate --version 2>&1 | head -n 1 ; echo DONE_LR`,
    detectCommand: `which logrotate && (logrotate --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    requiresSudo: true,
  },
  {
    id: 'supervisor',
    name: 'Supervisor',
    icon: '🧭',
    category: 'utilities',
    description: 'Controla e gerencia processos de longa execução (workers, serviços).',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y supervisor || apt-get install -y supervisor)) ; which supervisord ; (systemctl enable supervisor 2>/dev/null ; systemctl start supervisor 2>/dev/null ; service supervisor start 2>/dev/null ; true) ; supervisord --version 2>&1 | head -n 1 ; echo DONE_SUP`,
    detectCommand: `which supervisord && (supervisord --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    defaultPort: 9001,
    protocol: 'http',
    webPath: '/',
    startCommand: 'systemctl start supervisor 2>/dev/null || service supervisor start',
    stopCommand: 'systemctl stop supervisor 2>/dev/null || service supervisor stop',
    restartCommand: 'systemctl restart supervisor 2>/dev/null || service supervisor restart',
    postInstallHint: 'Adicione programas em /etc/supervisor/conf.d/*.conf. Use `supervisorctl reread && update`.',
    requiresSudo: true,
  },

  // --- extras: web ---
  {
    id: 'traefik',
    name: 'Traefik',
    icon: '🚦',
    category: 'web',
    description: 'Proxy reverso moderno com descoberta automática de containers Docker.',
    installCommand: `mkdir -p /opt/traefik 2>/dev/null ; cat > /opt/traefik/docker-compose.yml <<'EOF'
name: hub-traefik
services:
  traefik:
    image: traefik:v3.2
    container_name: traefik
    restart: unless-stopped
    command:
      - --api.insecure=true
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
    ports:
      - "8080:8080"
      - "8880:80"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    deploy:
      resources:
        limits:
          memory: 128M
EOF
(cd /opt/traefik && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_TRAEFIK`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^traefik$' && echo INSTALLED) || ([ -f /opt/traefik/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 8080,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/traefik',
    isDocker: true,
    composePath: '/opt/traefik',
    startCommand: 'cd /opt/traefik && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start traefik 2>/dev/null)',
    stopCommand: 'cd /opt/traefik && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop traefik 2>/dev/null)',
    restartCommand: 'cd /opt/traefik && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart traefik 2>/dev/null)',
    postInstallHint: 'Dashboard em http://localhost:8080. EntryPoint web em :8880.',
    requiresSudo: true,
  },
  {
    id: 'nodejs',
    name: 'Node.js',
    icon: '💚',
    category: 'web',
    description: 'Runtime JavaScript/TypeScript para APIs e apps no servidor.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y nodejs npm || apt-get install -y nodejs npm)) ; node -v ; npm -v ; echo DONE_NODE`,
    detectCommand: `which node && (node -v 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    postInstallHint: 'Use `node -v` e `npm -v`. Para versões LTS recentes, considere NodeSource ou nvm.',
    requiresSudo: true,
  },

  // --- extras: containers ---
  {
    id: 'dozzle',
    name: 'Dozzle',
    icon: '📜',
    category: 'containers',
    description: 'Visualizador web em tempo real de logs dos containers Docker.',
    installCommand: `mkdir -p /opt/dozzle 2>/dev/null ; cat > /opt/dozzle/docker-compose.yml <<'EOF'
name: hub-dozzle
services:
  dozzle:
    image: amir20/dozzle:latest
    container_name: dozzle
    restart: unless-stopped
    ports:
      - "8888:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    deploy:
      resources:
        limits:
          memory: 128M
EOF
(cd /opt/dozzle && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_DOZZLE`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^dozzle$' && echo INSTALLED) || ([ -f /opt/dozzle/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 8888,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/dozzle',
    isDocker: true,
    composePath: '/opt/dozzle',
    startCommand: 'cd /opt/dozzle && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start dozzle 2>/dev/null)',
    stopCommand: 'cd /opt/dozzle && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop dozzle 2>/dev/null)',
    restartCommand: 'cd /opt/dozzle && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart dozzle 2>/dev/null)',
    postInstallHint: 'Acesse http://localhost:8888 para ver logs ao vivo.',
    requiresSudo: true,
  },
  {
    id: 'watchtower',
    name: 'Watchtower',
    icon: '🛰️',
    category: 'containers',
    description: 'Atualiza containers Docker automaticamente quando há nova imagem.',
    installCommand: `mkdir -p /opt/watchtower 2>/dev/null ; cat > /opt/watchtower/docker-compose.yml <<'EOF'
name: hub-watchtower
services:
  watchtower:
    image: containrrr/watchtower:latest
    container_name: watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_CLEANUP: "true"
      WATCHTOWER_POLL_INTERVAL: "86400"
    deploy:
      resources:
        limits:
          memory: 64M
EOF
(cd /opt/watchtower && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_WATCHTOWER`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^watchtower$' && echo INSTALLED) || ([ -f /opt/watchtower/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    hasWebUi: false,
    isDocker: true,
    composePath: '/opt/watchtower',
    startCommand: 'cd /opt/watchtower && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start watchtower 2>/dev/null)',
    stopCommand: 'cd /opt/watchtower && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop watchtower 2>/dev/null)',
    restartCommand: 'cd /opt/watchtower && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart watchtower 2>/dev/null)',
    postInstallHint: 'Roda em background e verifica updates 1x/dia. Logs: docker logs watchtower.',
    requiresSudo: true,
  },
  {
    id: 'cadvisor',
    name: 'cAdvisor',
    icon: '📊',
    category: 'containers',
    description: 'Métricas de uso de CPU, RAM e disco por container (Google).',
    installCommand: `mkdir -p /opt/cadvisor 2>/dev/null ; cat > /opt/cadvisor/docker-compose.yml <<'EOF'
name: hub-cadvisor
services:
  cadvisor:
    image: gcr.io/cadvisor/cadvisor:v0.49.1
    container_name: cadvisor
    restart: unless-stopped
    ports:
      - "8089:8080"
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    privileged: true
    deploy:
      resources:
        limits:
          memory: 192M
EOF
(cd /opt/cadvisor && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_CADVISOR`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^cadvisor$' && echo INSTALLED) || ([ -f /opt/cadvisor/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 8089,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/cadvisor',
    isDocker: true,
    composePath: '/opt/cadvisor',
    startCommand: 'cd /opt/cadvisor && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start cadvisor 2>/dev/null)',
    stopCommand: 'cd /opt/cadvisor && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop cadvisor 2>/dev/null)',
    restartCommand: 'cd /opt/cadvisor && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart cadvisor 2>/dev/null)',
    postInstallHint: 'Acesse http://localhost:8089 para métricas por container.',
    requiresSudo: true,
  },

  // --- extras: database ---
  {
    id: 'adminer',
    name: 'Adminer',
    icon: '🧰',
    category: 'database',
    description: 'UI web leve para MySQL, PostgreSQL, SQLite e outros bancos.',
    installCommand: `mkdir -p /opt/adminer 2>/dev/null ; cat > /opt/adminer/docker-compose.yml <<'EOF'
name: hub-adminer
services:
  adminer:
    image: adminer:4
    container_name: adminer
    restart: unless-stopped
    ports:
      - "8082:8080"
    environment:
      ADMINER_DEFAULT_SERVER: postgres
    deploy:
      resources:
        limits:
          memory: 128M
EOF
(cd /opt/adminer && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_ADMINER`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^adminer$' && echo INSTALLED) || ([ -f /opt/adminer/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 8082,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/adminer',
    isDocker: true,
    composePath: '/opt/adminer',
    startCommand: 'cd /opt/adminer && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start adminer 2>/dev/null)',
    stopCommand: 'cd /opt/adminer && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop adminer 2>/dev/null)',
    restartCommand: 'cd /opt/adminer && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart adminer 2>/dev/null)',
    postInstallHint: 'Acesse http://localhost:8082. Para Postgres do hub use host postgres e porta 5432 (rede Docker) ou host.docker.internal:5433.',
    requiresSudo: true,
  },
  {
    id: 'phpmyadmin',
    name: 'phpMyAdmin',
    icon: '🗄️',
    category: 'database',
    description: 'Painel web clássico para administrar MySQL/MariaDB.',
    installCommand: `mkdir -p /opt/phpmyadmin 2>/dev/null ; cat > /opt/phpmyadmin/docker-compose.yml <<'EOF'
name: hub-phpmyadmin
services:
  phpmyadmin:
    image: phpmyadmin:5
    container_name: phpmyadmin
    restart: unless-stopped
    ports:
      - "8084:80"
    environment:
      PMA_HOST: mariadb
      PMA_PORT: 3306
      UPLOAD_LIMIT: 64M
    deploy:
      resources:
        limits:
          memory: 192M
EOF
(cd /opt/phpmyadmin && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; docker network connect hub-mariadb_default phpmyadmin 2>/dev/null || docker network connect mariadb_default phpmyadmin 2>/dev/null || true ; echo DONE_PMA`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^phpmyadmin$' && echo INSTALLED) || ([ -f /opt/phpmyadmin/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 8084,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/phpmyadmin',
    isDocker: true,
    composePath: '/opt/phpmyadmin',
    startCommand: 'cd /opt/phpmyadmin && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start phpmyadmin 2>/dev/null)',
    stopCommand: 'cd /opt/phpmyadmin && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop phpmyadmin 2>/dev/null)',
    restartCommand: 'cd /opt/phpmyadmin && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart phpmyadmin 2>/dev/null)',
    postInstallHint: 'Acesse http://localhost:8084. Instale MariaDB antes e use user/password do compose.',
    requiresSudo: true,
  },
  {
    id: 'mongo-express',
    name: 'Mongo Express',
    icon: '🍃',
    category: 'database',
    description: 'Interface web para explorar e editar bancos MongoDB.',
    installCommand: `mkdir -p /opt/mongo-express 2>/dev/null ; cat > /opt/mongo-express/docker-compose.yml <<'EOF'
name: hub-mongo-express
services:
  mongo-express:
    image: mongo-express:1.0.2-20
    container_name: mongo-express
    restart: unless-stopped
    ports:
      - "8085:8081"
    environment:
      ME_CONFIG_MONGODB_ADMINUSERNAME: root
      ME_CONFIG_MONGODB_ADMINPASSWORD: rootpassword
      ME_CONFIG_MONGODB_URL: mongodb://root:rootpassword@mongodb:27017/
      ME_CONFIG_BASICAUTH: "false"
    deploy:
      resources:
        limits:
          memory: 192M
EOF
(cd /opt/mongo-express && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; docker network connect hub-mongodb_default mongo-express 2>/dev/null || docker network connect mongodb_default mongo-express 2>/dev/null || true ; echo DONE_MONGOEX`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^mongo-express$' && echo INSTALLED) || ([ -f /opt/mongo-express/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 8085,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/mongo-express',
    isDocker: true,
    composePath: '/opt/mongo-express',
    startCommand: 'cd /opt/mongo-express && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start mongo-express 2>/dev/null)',
    stopCommand: 'cd /opt/mongo-express && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop mongo-express 2>/dev/null)',
    restartCommand: 'cd /opt/mongo-express && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart mongo-express 2>/dev/null)',
    postInstallHint: 'Acesse http://localhost:8085. Requer MongoDB instalado no hub.',
    requiresSudo: true,
  },
  {
    id: 'redis-commander',
    name: 'Redis Commander',
    icon: '🔴',
    category: 'database',
    description: 'UI web para inspecionar chaves, TTL e valores no Redis.',
    installCommand: `mkdir -p /opt/redis-commander 2>/dev/null ; cat > /opt/redis-commander/docker-compose.yml <<'EOF'
name: hub-redis-commander
services:
  redis-commander:
    image: rediscommander/redis-commander:latest
    container_name: redis-commander
    restart: unless-stopped
    ports:
      - "8086:8081"
    environment:
      REDIS_HOSTS: local:redis:6379
    deploy:
      resources:
        limits:
          memory: 128M
EOF
(cd /opt/redis-commander && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; docker network connect hub-redis_default redis-commander 2>/dev/null || docker network connect redis_default redis-commander 2>/dev/null || true ; echo DONE_REDISCMD`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^redis-commander$' && echo INSTALLED) || ([ -f /opt/redis-commander/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 8086,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/redis-commander',
    isDocker: true,
    composePath: '/opt/redis-commander',
    startCommand: 'cd /opt/redis-commander && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start redis-commander 2>/dev/null)',
    stopCommand: 'cd /opt/redis-commander && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop redis-commander 2>/dev/null)',
    restartCommand: 'cd /opt/redis-commander && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart redis-commander 2>/dev/null)',
    postInstallHint: 'Acesse http://localhost:8086. Instale Redis antes.',
    requiresSudo: true,
  },
  {
    id: 'rabbitmq',
    name: 'RabbitMQ',
    icon: '🐇',
    category: 'database',
    description: 'Broker de mensagens com painel de gestão embutido.',
    installCommand: `mkdir -p /opt/rabbitmq 2>/dev/null ; cat > /opt/rabbitmq/docker-compose.yml <<'EOF'
name: hub-rabbitmq
services:
  rabbitmq:
    image: rabbitmq:3.13-management-alpine
    container_name: rabbitmq
    restart: unless-stopped
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: admin
      RABBITMQ_DEFAULT_PASS: admin
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 30s
      timeout: 10s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 384M

volumes:
  rabbitmq_data:
EOF
(cd /opt/rabbitmq && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_RABBIT`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^rabbitmq$' && echo INSTALLED) || ([ -f /opt/rabbitmq/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 15672,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/rabbitmq',
    connectionString: 'amqp://admin:admin@localhost:5672',
    isDocker: true,
    composePath: '/opt/rabbitmq',
    startCommand: 'cd /opt/rabbitmq && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start rabbitmq 2>/dev/null)',
    stopCommand: 'cd /opt/rabbitmq && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop rabbitmq 2>/dev/null)',
    restartCommand: 'cd /opt/rabbitmq && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart rabbitmq 2>/dev/null)',
    postInstallHint: 'Management UI: http://localhost:15672 (admin/admin). AMQP na porta 5672.',
    requiresSudo: true,
  },
  {
    id: 'meilisearch',
    name: 'Meilisearch',
    icon: '🔎',
    category: 'database',
    description: 'Motor de busca full-text rápido e fácil de integrar.',
    installCommand: `mkdir -p /opt/meilisearch 2>/dev/null ; cat > /opt/meilisearch/docker-compose.yml <<'EOF'
name: hub-meilisearch
services:
  meilisearch:
    image: getmeili/meilisearch:v1.11
    container_name: meilisearch
    restart: unless-stopped
    ports:
      - "7700:7700"
    environment:
      MEILI_ENV: development
      MEILI_NO_ANALYTICS: "true"
      MEILI_MASTER_KEY: masterKeyChangeMe
    volumes:
      - meili_data:/meili_data
    deploy:
      resources:
        limits:
          memory: 512M

volumes:
  meili_data:
EOF
(cd /opt/meilisearch && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_MEILI`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^meilisearch$' && echo INSTALLED) || ([ -f /opt/meilisearch/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 7700,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/meilisearch',
    connectionString: 'http://localhost:7700',
    isDocker: true,
    composePath: '/opt/meilisearch',
    startCommand: 'cd /opt/meilisearch && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start meilisearch 2>/dev/null)',
    stopCommand: 'cd /opt/meilisearch && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop meilisearch 2>/dev/null)',
    restartCommand: 'cd /opt/meilisearch && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart meilisearch 2>/dev/null)',
    postInstallHint: 'API em http://localhost:7700. Header Authorization: Bearer masterKeyChangeMe.',
    requiresSudo: true,
  },

  // --- extras: filemanager / painéis ---
  {
    id: 'filebrowser',
    name: 'File Browser',
    icon: '📂',
    category: 'filemanager',
    description: 'Gerenciador de arquivos web moderno com upload, preview e usuários.',
    installCommand: `mkdir -p /opt/filebrowser /hub-apps 2>/dev/null ; cat > /opt/filebrowser/docker-compose.yml <<'EOF'
name: hub-filebrowser
services:
  filebrowser:
    image: filebrowser/filebrowser:v2
    container_name: filebrowser
    restart: unless-stopped
    ports:
      - "8087:80"
    volumes:
      - /hub-apps:/srv
      - filebrowser_data:/database
    deploy:
      resources:
        limits:
          memory: 128M

volumes:
  filebrowser_data:
EOF
(cd /opt/filebrowser && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_FILEBROWSER`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^filebrowser$' && echo INSTALLED) || ([ -f /opt/filebrowser/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 8087,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/filebrowser',
    isDocker: true,
    composePath: '/opt/filebrowser',
    startCommand: 'cd /opt/filebrowser && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start filebrowser 2>/dev/null)',
    stopCommand: 'cd /opt/filebrowser && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop filebrowser 2>/dev/null)',
    restartCommand: 'cd /opt/filebrowser && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart filebrowser 2>/dev/null)',
    postInstallHint: 'Acesse http://localhost:8087. Login padrão admin/admin (troque na 1ª vez).',
    requiresSudo: true,
  },
  {
    id: 'gitea',
    name: 'Gitea',
    icon: '🍵',
    category: 'filemanager',
    description: 'Git self-hosted leve — repositórios, issues e CI simples.',
    installCommand: `mkdir -p /opt/gitea 2>/dev/null ; cat > /opt/gitea/docker-compose.yml <<'EOF'
name: hub-gitea
services:
  gitea:
    image: gitea/gitea:1.22.3
    container_name: gitea
    restart: unless-stopped
    ports:
      - "3004:3000"
      - "2222:22"
    environment:
      USER_UID: 1000
      USER_GID: 1000
      GITEA__server__ROOT_URL: http://localhost:3004/
    volumes:
      - gitea_data:/data
    deploy:
      resources:
        limits:
          memory: 512M

volumes:
  gitea_data:
EOF
(cd /opt/gitea && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_GITEA`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^gitea$' && echo INSTALLED) || ([ -f /opt/gitea/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 3004,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/gitea',
    isDocker: true,
    composePath: '/opt/gitea',
    startCommand: 'cd /opt/gitea && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start gitea 2>/dev/null)',
    stopCommand: 'cd /opt/gitea && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop gitea 2>/dev/null)',
    restartCommand: 'cd /opt/gitea && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart gitea 2>/dev/null)',
    postInstallHint: 'Acesse http://localhost:3004 e complete o wizard. SSH Git na porta 2222.',
    requiresSudo: true,
  },
  {
    id: 'code-server',
    name: 'code-server',
    icon: '💻',
    category: 'filemanager',
    description: 'VS Code no navegador para editar código no servidor.',
    installCommand: `mkdir -p /opt/code-server /hub-apps 2>/dev/null ; cat > /opt/code-server/docker-compose.yml <<'EOF'
name: hub-code-server
services:
  code-server:
    image: codercom/code-server:4.96.2
    container_name: code-server
    restart: unless-stopped
    ports:
      - "8443:8080"
    environment:
      PASSWORD: changeme
    volumes:
      - /hub-apps:/home/coder/project
      - code_server_data:/home/coder
    deploy:
      resources:
        limits:
          memory: 768M

volumes:
  code_server_data:
EOF
(cd /opt/code-server && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_CODESERVER`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^code-server$' && echo INSTALLED) || ([ -f /opt/code-server/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 8443,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/code-server',
    isDocker: true,
    composePath: '/opt/code-server',
    startCommand: 'cd /opt/code-server && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start code-server 2>/dev/null)',
    stopCommand: 'cd /opt/code-server && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop code-server 2>/dev/null)',
    restartCommand: 'cd /opt/code-server && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart code-server 2>/dev/null)',
    postInstallHint: 'Acesse http://localhost:8443. Senha: changeme (altere no compose).',
    requiresSudo: true,
  },
  {
    id: 'minio',
    name: 'MinIO',
    icon: '📦',
    category: 'filemanager',
    description: 'Object storage S3-compatível para arquivos, backups e mídia.',
    installCommand: `mkdir -p /opt/minio 2>/dev/null ; cat > /opt/minio/docker-compose.yml <<'EOF'
name: hub-minio
services:
  minio:
    image: minio/minio:RELEASE.2024-12-18T13-15-44Z
    container_name: minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    ports:
      - "9010:9000"
      - "9011:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - minio_data:/data
    deploy:
      resources:
        limits:
          memory: 512M

volumes:
  minio_data:
EOF
(cd /opt/minio && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_MINIO`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^minio$' && echo INSTALLED) || ([ -f /opt/minio/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 9011,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/minio',
    connectionString: 'http://localhost:9010',
    isDocker: true,
    composePath: '/opt/minio',
    startCommand: 'cd /opt/minio && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start minio 2>/dev/null)',
    stopCommand: 'cd /opt/minio && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop minio 2>/dev/null)',
    restartCommand: 'cd /opt/minio && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart minio 2>/dev/null)',
    postInstallHint: 'Console: http://localhost:9011 (minioadmin/minioadmin). API S3: http://localhost:9010.',
    requiresSudo: true,
  },
  {
    id: 'n8n',
    name: 'n8n',
    icon: '🔗',
    category: 'filemanager',
    description: 'Automação de workflows (estilo Zapier) self-hosted.',
    installCommand: `mkdir -p /opt/n8n 2>/dev/null ; cat > /opt/n8n/docker-compose.yml <<'EOF'
name: hub-n8n
services:
  n8n:
    image: n8nio/n8n:1.72.1
    container_name: n8n
    restart: unless-stopped
    ports:
      - "5678:5678"
    environment:
      N8N_HOST: localhost
      N8N_PORT: 5678
      N8N_PROTOCOL: http
      WEBHOOK_URL: http://localhost:5678/
      GENERIC_TIMEZONE: America/Sao_Paulo
    volumes:
      - n8n_data:/home/node/.n8n
    deploy:
      resources:
        limits:
          memory: 512M

volumes:
  n8n_data:
EOF
(cd /opt/n8n && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_N8N`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^n8n$' && echo INSTALLED) || ([ -f /opt/n8n/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 5678,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/n8n',
    isDocker: true,
    composePath: '/opt/n8n',
    startCommand: 'cd /opt/n8n && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start n8n 2>/dev/null)',
    stopCommand: 'cd /opt/n8n && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop n8n 2>/dev/null)',
    restartCommand: 'cd /opt/n8n && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart n8n 2>/dev/null)',
    postInstallHint: 'Acesse http://localhost:5678 e crie o usuário admin na primeira abertura.',
    requiresSudo: true,
  },
  {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    icon: '🔐',
    category: 'filemanager',
    description: 'Servidor Bitwarden leve para senhas e 2FA da equipe.',
    installCommand: `mkdir -p /opt/vaultwarden 2>/dev/null ; cat > /opt/vaultwarden/docker-compose.yml <<'EOF'
name: hub-vaultwarden
services:
  vaultwarden:
    image: vaultwarden/server:1.32.7
    container_name: vaultwarden
    restart: unless-stopped
    ports:
      - "8222:80"
    environment:
      SIGNUPS_ALLOWED: "true"
      DOMAIN: http://localhost:8222
    volumes:
      - vaultwarden_data:/data
    deploy:
      resources:
        limits:
          memory: 256M

volumes:
  vaultwarden_data:
EOF
(cd /opt/vaultwarden && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_VW`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^vaultwarden$' && echo INSTALLED) || ([ -f /opt/vaultwarden/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 8222,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/vaultwarden',
    isDocker: true,
    composePath: '/opt/vaultwarden',
    startCommand: 'cd /opt/vaultwarden && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start vaultwarden 2>/dev/null)',
    stopCommand: 'cd /opt/vaultwarden && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop vaultwarden 2>/dev/null)',
    restartCommand: 'cd /opt/vaultwarden && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart vaultwarden 2>/dev/null)',
    postInstallHint: 'Acesse http://localhost:8222. Desative SIGNUPS_ALLOWED após criar o admin.',
    requiresSudo: true,
  },

  // --- extras: security ---
  {
    id: 'crowdsec',
    name: 'CrowdSec',
    icon: '🛡️',
    category: 'security',
    description: 'IDS colaborativo que bloqueia IPs maliciosos com base em comportamento.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y curl gnupg || apt-get install -y curl gnupg)) ; curl -fsSL https://packagecloud.io/crowdsec/crowdsec/gpgkey 2>/dev/null | (sudo -n true 2>/dev/null && sudo gpg --dearmor -o /usr/share/keyrings/crowdsec-archive-keyring.gpg || gpg --dearmor -o /usr/share/keyrings/crowdsec-archive-keyring.gpg) >/dev/null 2>&1 ; echo "deb [signed-by=/usr/share/keyrings/crowdsec-archive-keyring.gpg] https://packagecloud.io/crowdsec/crowdsec/any any main" 2>/dev/null | (sudo -n true 2>/dev/null && sudo tee /etc/apt/sources.list.d/crowdsec.list || tee /etc/apt/sources.list.d/crowdsec.list) >/dev/null ; ${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y crowdsec || apt-get install -y crowdsec)) ; which cscli ; echo DONE_CROWDSEC`,
    detectCommand: `which cscli && (cscli version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    startCommand: 'systemctl start crowdsec 2>/dev/null || service crowdsec start',
    stopCommand: 'systemctl stop crowdsec 2>/dev/null || service crowdsec stop',
    restartCommand: 'systemctl restart crowdsec 2>/dev/null || service crowdsec restart',
    postInstallHint: 'Veja alertas com `cscli alerts list`. Instale bouncers (firewall) conforme a doc.',
    requiresSudo: true,
  },
  {
    id: 'clamav',
    name: 'ClamAV',
    icon: '🦠',
    category: 'security',
    description: 'Antivírus open source para escanear arquivos e pastas no servidor.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y clamav clamav-daemon || apt-get install -y clamav clamav-daemon)) ; (systemctl stop clamav-freshclam 2>/dev/null ; freshclam 2>&1 | tail -n 5 ; systemctl start clamav-freshclam 2>/dev/null ; systemctl enable --now clamav-daemon 2>/dev/null ; true) ; which clamscan ; echo DONE_CLAMAV`,
    detectCommand: `which clamscan && (clamscan --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    startCommand: 'systemctl start clamav-daemon 2>/dev/null || service clamav-daemon start',
    stopCommand: 'systemctl stop clamav-daemon 2>/dev/null || service clamav-daemon stop',
    restartCommand: 'systemctl restart clamav-daemon 2>/dev/null || service clamav-daemon restart',
    postInstallHint: 'Escaneie com `clamscan -r /caminho`. Atualize bases com `freshclam`.',
    requiresSudo: true,
  },

  // --- extras: monitoring ---
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    icon: '💚',
    category: 'monitoring',
    description: 'Monitor de uptime com status page, alertas e checks HTTP/TCP.',
    installCommand: `mkdir -p /opt/uptime-kuma 2>/dev/null ; cat > /opt/uptime-kuma/docker-compose.yml <<'EOF'
name: hub-uptime-kuma
services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    container_name: uptime-kuma
    restart: unless-stopped
    ports:
      - "3003:3001"
    volumes:
      - uptime_kuma_data:/app/data
    deploy:
      resources:
        limits:
          memory: 384M

volumes:
  uptime_kuma_data:
EOF
(cd /opt/uptime-kuma && (docker compose up -d 2>&1 || docker-compose up -d 2>&1) | tail -n 5) ; echo DONE_KUMA`,
    detectCommand: `(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^uptime-kuma$' && echo INSTALLED) || ([ -f /opt/uptime-kuma/docker-compose.yml ] && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 3003,
    hasWebUi: true,
    protocol: 'http',
    webPath: '/',
    nginxPath: '/uptime-kuma',
    isDocker: true,
    composePath: '/opt/uptime-kuma',
    startCommand: 'cd /opt/uptime-kuma && (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || docker start uptime-kuma 2>/dev/null)',
    stopCommand: 'cd /opt/uptime-kuma && (docker compose down 2>/dev/null || docker-compose down 2>/dev/null || docker stop uptime-kuma 2>/dev/null)',
    restartCommand: 'cd /opt/uptime-kuma && (docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || docker restart uptime-kuma 2>/dev/null)',
    postInstallHint: 'Acesse http://localhost:3003 e crie o admin na primeira vez.',
    requiresSudo: true,
  },
  {
    id: 'sys-diag',
    name: 'Diagnóstico (iftop/iotop/ncdu)',
    icon: '📡',
    category: 'monitoring',
    description: 'Ferramentas CLI de diagnóstico de rede e disco (iftop, iotop, ncdu, nethogs).',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y iftop iotop ncdu nethogs || apt-get install -y iftop iotop ncdu nethogs)) ; which ncdu ; echo DONE_DIAG`,
    detectCommand: `(which ncdu && which iftop && echo INSTALLED) || echo NOT_INSTALLED`,
    postInstallHint: 'Use `ncdu /`, `iftop`, `iotop` e `nethogs` no terminal.',
    requiresSudo: true,
  },

  // --- extras: utilities ---
  {
    id: 'python3',
    name: 'Python 3',
    icon: '🐍',
    category: 'utilities',
    description: 'Runtime Python com pip e venv para scripts e automação.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y python3 python3-pip python3-venv || apt-get install -y python3 python3-pip python3-venv)) ; python3 --version ; pip3 --version ; echo DONE_PY`,
    detectCommand: `which python3 && (python3 --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    postInstallHint: 'Crie venv: `python3 -m venv .venv && source .venv/bin/activate`.',
    requiresSudo: true,
  },
  {
    id: 'build-essential',
    name: 'Build Essential',
    icon: '🧱',
    category: 'utilities',
    description: 'Compilador GCC, make e headers para build nativo de pacotes.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y build-essential make cmake pkg-config || apt-get install -y build-essential make cmake pkg-config)) ; gcc --version | head -n 1 ; echo DONE_BUILD`,
    detectCommand: `which gcc && (gcc --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    requiresSudo: true,
  },
  {
    id: 'jq',
    name: 'jq / yq',
    icon: '🧾',
    category: 'utilities',
    description: 'Processadores CLI de JSON e YAML para scripts e APIs.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y jq || apt-get install -y jq)) ; (curl -fsSL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -o /tmp/yq 2>/dev/null && (sudo -n true 2>/dev/null && sudo install -m 755 /tmp/yq /usr/local/bin/yq || install -m 755 /tmp/yq /usr/local/bin/yq) ; rm -f /tmp/yq ; true) ; jq --version ; yq --version 2>/dev/null || true ; echo DONE_JQ`,
    detectCommand: `which jq && (jq --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    requiresSudo: true,
  },
  {
    id: 'zip-tools',
    name: 'Zip / Unzip / 7zip',
    icon: '🗜️',
    category: 'utilities',
    description: 'Ferramentas de compressão e descompactação de arquivos.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y zip unzip p7zip-full || apt-get install -y zip unzip p7zip-full)) ; which zip ; which unzip ; echo DONE_ZIP`,
    detectCommand: `(which zip && which unzip && echo INSTALLED) || echo NOT_INSTALLED`,
    requiresSudo: true,
  },
  {
    id: 'ffmpeg',
    name: 'FFmpeg',
    icon: '🎬',
    category: 'utilities',
    description: 'Conversão e processamento de áudio/vídeo via linha de comando.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y ffmpeg || apt-get install -y ffmpeg)) ; ffmpeg -version 2>&1 | head -n 1 ; echo DONE_FFMPEG`,
    detectCommand: `which ffmpeg && (ffmpeg -version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    requiresSudo: true,
  },
  {
    id: 'imagemagick',
    name: 'ImageMagick',
    icon: '🖼️',
    category: 'utilities',
    description: 'Manipulação de imagens (resize, convert, compose) no CLI.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y imagemagick || apt-get install -y imagemagick)) ; convert -version 2>&1 | head -n 1 ; echo DONE_IM`,
    detectCommand: `(which convert || which magick) && (convert -version 2>&1 | head -n 1 || magick -version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    requiresSudo: true,
  },
  {
    id: 'rclone',
    name: 'Rclone',
    icon: '☁️',
    category: 'utilities',
    description: 'Sincroniza arquivos com S3, Drive, Dropbox, MinIO e outros.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y rclone || apt-get install -y rclone)) ; which rclone ; rclone version 2>&1 | head -n 2 ; echo DONE_RCLONE`,
    detectCommand: `which rclone && (rclone version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    postInstallHint: 'Configure com `rclone config`. Útil com MinIO e backups offsite.',
    requiresSudo: true,
  },
  {
    id: 'restic',
    name: 'Restic',
    icon: '💾',
    category: 'utilities',
    description: 'Backup incremental criptografado, rápido e confiável.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y restic || apt-get install -y restic)) ; which restic ; restic version 2>&1 ; echo DONE_RESTIC`,
    detectCommand: `which restic && (restic version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    postInstallHint: 'Init: `restic -r /backup init`. Backup: `restic -r /backup backup /dados`.',
    requiresSudo: true,
  },
  {
    id: 'neovim',
    name: 'Neovim',
    icon: '📝',
    category: 'utilities',
    description: 'Editor de texto moderno no terminal (melhor que vim clássico).',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y neovim || apt-get install -y neovim)) ; which nvim ; nvim --version 2>&1 | head -n 1 ; echo DONE_NVIM`,
    detectCommand: `which nvim && (nvim --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    requiresSudo: true,
  },
  {
    id: 'httpie',
    name: 'HTTPie',
    icon: '📡',
    category: 'utilities',
    description: 'Cliente HTTP amigável para testar APIs no terminal.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y httpie || apt-get install -y httpie)) ; which http ; http --version 2>&1 | head -n 1 ; echo DONE_HTTPIE`,
    detectCommand: `which http && (http --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    postInstallHint: 'Exemplo: `http GET http://localhost:3001/health`.',
    requiresSudo: true,
  },
  {
    id: 'wireguard',
    name: 'WireGuard',
    icon: '🔐',
    category: 'security',
    description: 'VPN moderna, rápida e simples para acesso seguro ao servidor.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y wireguard wireguard-tools || apt-get install -y wireguard wireguard-tools)) ; which wg ; wg --version 2>&1 | head -n 1 ; echo DONE_WG`,
    detectCommand: `which wg && (wg --version 2>&1 | head -n 1) || echo NOT_INSTALLED`,
    postInstallHint: 'Gere chaves com `wg genkey`. Configs em /etc/wireguard/.',
    requiresSudo: true,
  },
  {
    id: 'openssh-server',
    name: 'OpenSSH Server',
    icon: '🔑',
    category: 'security',
    description: 'Servidor SSH para acesso remoto seguro ao host.',
    installCommand: `${APT_UPDATE} ; (which apt-get >/dev/null && (sudo -n true 2>/dev/null && sudo apt-get install -y openssh-server || apt-get install -y openssh-server)) ; (systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null || service ssh start 2>/dev/null ; true) ; which sshd ; echo DONE_SSH`,
    detectCommand: `(which sshd && echo INSTALLED) || (systemctl is-active ssh 2>/dev/null | grep -q active && echo INSTALLED) || echo NOT_INSTALLED`,
    defaultPort: 22,
    startCommand: 'systemctl start ssh 2>/dev/null || systemctl start sshd 2>/dev/null || service ssh start',
    stopCommand: 'systemctl stop ssh 2>/dev/null || systemctl stop sshd 2>/dev/null || service ssh stop',
    restartCommand: 'systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart',
    postInstallHint: 'Confirme `sshd` ativo. Prefira chave SSH e desative senha em produção.',
    requiresSudo: true,
  },
];

CATALOG.forEach((app) => {
  if (app.requiresSudo === undefined) {
    const cmd = `${app.installCommand} `.toLowerCase();
    app.requiresSudo =
      cmd.includes('apt-get') ||
      cmd.includes('apt install') ||
      cmd.includes('systemctl enable') ||
      cmd.includes('systemctl start') ||
      cmd.includes('ufw ') ||
      cmd.includes('dpkg') ||
      cmd.includes('add-apt-repository') ||
      cmd.includes('curl -fssl') ||
      cmd.includes('curl -ssl') ||
      cmd.includes('sh -s') ||
      cmd.includes('sudo') ||
      cmd.includes('mkdir -p /opt') ||
      cmd.includes('mkdir -p /etc') ||
      cmd.includes('/usr/local/');
  }
});

export class AppsService {
  private jobs: Map<string, InstallJob> = new Map();

  private normalizeJobOutput(job: InstallJob): void {
    job.output = truncateText(job.output, MAX_JOB_OUTPUT_CHARS);
  }

  private appendJobOutput(job: InstallJob, text: string): void {
    job.output = appendBoundedText(job.output, text);
  }

  private storeJob(job: InstallJob): void {
    this.normalizeJobOutput(job);
    this.jobs.set(job.jobId, job);
    this.evictFinishedJobs();
  }

  private evictFinishedJobs(): void {
    if (this.jobs.size <= MAX_JOBS_IN_MEMORY) return;
    const finished = Array.from(this.jobs.values())
      .filter((job) => job.status !== 'running')
      .sort((a, b) => (a.finishedAt || a.startedAt) - (b.finishedAt || b.startedAt));
    while (this.jobs.size > MAX_JOBS_IN_MEMORY && finished.length > 0) {
      const oldest = finished.shift()!;
      this.jobs.delete(oldest.jobId);
    }
  }

  async reloadInstallJobs(): Promise<void> {
    const jobs = await loadInstallJobs(MAX_JOBS_IN_MEMORY);
    this.jobs.clear();
    for (const job of jobs) {
      this.normalizeJobOutput(job);
      this.jobs.set(job.jobId, job);
    }
  }

  getCatalog(): CatalogApp[] {
    return CATALOG.slice();
  }

  getCategories() {
    return APP_CATEGORIES.slice();
  }

  async listInstalled(): Promise<InstalledApp[]> {
    const out: InstalledApp[] = [];
    for (const app of CATALOG) {
      let installed = false;
      let version: string | undefined;
      let running: boolean | null = null;
      let status: string | undefined;

      try {
        const r = await serverManagerService.executeCommand({
          command: app.detectCommand,
          timeout: 15000,
        });
        const raw = (r.stdout || '').trim();
        if (!raw || raw.includes('NOT_INSTALLED')) {
          installed = false;
        } else {
          installed = true;
          version = raw.replace(/\r?\n/g, ' | ').slice(0, 220);
          status = raw.includes('INSTALLED') ? 'INSTALLED' : 'Detected';
        }
      } catch {}

      if (installed && app.defaultPort) {
        try {
          const runCheck = await serverManagerService.executeCommand({
            command: `(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | awk '{print $4}' | grep -E '[:.]${app.defaultPort}$|\\[::\\]:${app.defaultPort}' || (ss -tlnp 2>/dev/null | grep ":${app.defaultPort} ") || echo NOT_LISTENING`,
            timeout: 10000,
          });
          const listen = (runCheck.stdout || '').trim();
          running = !(!listen || listen.includes('NOT_LISTENING'));
        } catch {}
      } else if (installed && app.isDocker) {
        try {
          const runCheck = await serverManagerService.executeCommand({
            command: `docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^(${app.id}|${app.name.toLowerCase()})' || echo NOT_RUNNING`,
            timeout: 10000,
          });
          const dOut = (runCheck.stdout || '').trim();
          if (dOut && !dOut.includes('NOT_RUNNING')) {
            running = true;
          }
        } catch {}
      }

      out.push({
        id: app.id,
        name: app.name,
        icon: app.icon,
        category: app.category,
        description: app.description,
        installed,
        version,
        running,
        status,
        defaultPort: app.defaultPort,
        docsUrl: app.docsUrl,
        postInstallHint: app.postInstallHint,
        startCommand: app.startCommand,
        stopCommand: app.stopCommand,
        restartCommand: app.restartCommand,
        composePath: app.composePath,
        isDocker: app.isDocker,
        protocol: app.protocol,
        webPath: app.webPath,
        hasWebUi: app.hasWebUi,
        connectionString: app.connectionString,
        nginxPath: app.nginxPath,
        nginxSubdomain: app.nginxSubdomain,
        ...(installed ? buildAppUrls(app) : {}),
      });
    }
    return out;
  }

  getInstalledTunnelPaths(installed: InstalledApp[]): string[] {
    const paths: string[] = [];
    for (const item of installed) {
      if (!item.installed) continue;
      const catalog = CATALOG.find((c) => c.id === item.id);
      if (!catalog?.nginxPath || catalog.nginxPath === '/' || catalog.hasWebUi === false) continue;
      const segment = catalog.nginxPath.replace(/^\/+|\/+$/g, '');
      if (!segment || RESERVED_TUNNEL_PATHS.has(segment)) continue;
      paths.push(segment);
    }
    return paths;
  }

  private catalogApacheBlock(installed: InstalledApp[]): string {
    const parts = [BEGIN_CATALOG_MARK];
    for (const item of installed) {
      if (!item.installed) continue;
      const catalog = CATALOG.find((c) => c.id === item.id);
      if (!catalog?.nginxPath || !catalog.defaultPort || catalog.nginxPath === '/') continue;
      if (catalog.hasWebUi === false) continue;
      const route = catalog.nginxPath.replace(/\/$/, '') || `/${catalog.id}`;
      const segment = route.replace(/^\/+/, '');
      if (!segment || RESERVED_TUNNEL_PATHS.has(segment)) continue;
      const location = `${route}/`;
      parts.push(`RedirectMatch permanent ^${route}$ ${location}`);
      if (catalog.id === 'pgadmin') {
        parts.push(
          `<Location ${location}>\n    ProxyPreserveHost On\n    RequestHeader set X-Script-Name ${route}\n    RequestHeader set X-Forwarded-Proto "https"\n    RequestHeader set X-Forwarded-Prefix ${route}\n    ProxyPass http://${APACHE_BACKEND_HOST}:${catalog.defaultPort}/\n    ProxyPassReverse http://${APACHE_BACKEND_HOST}:${catalog.defaultPort}/\n</Location>`
        );
      } else {
        parts.push(
          `<Location ${location}>\n    ProxyPreserveHost On\n    ProxyPass http://${APACHE_BACKEND_HOST}:${catalog.defaultPort}/\n    ProxyPassReverse http://${APACHE_BACKEND_HOST}:${catalog.defaultPort}/\n</Location>`
        );
      }
    }
    parts.push(END_CATALOG_MARK);
    return parts.join('\n');
  }

  private async repairCatalogContainers(installed: InstalledApp[]): Promise<void> {
    if (installed.some((item) => item.installed && item.id === 'pgadmin')) {
      await this.repairPgAdminSubpath();
    }
  }

  private async repairPgAdminSubpath(): Promise<void> {
    const script = `
COMPOSE=/opt/pgadmin/docker-compose.yml
if [ ! -f "$COMPOSE" ]; then
  echo PGADMIN_SKIP
  exit 0
fi
if ! grep -q 'SCRIPT_NAME: /pgadmin' "$COMPOSE" 2>/dev/null; then
  python3 - <<'PY'
from pathlib import Path
path = Path("/opt/pgadmin/docker-compose.yml")
text = path.read_text()
needle = "PGADMIN_LISTEN_PORT: 80"
insert = "PGADMIN_LISTEN_PORT: 80\\n      SCRIPT_NAME: /pgadmin"
if "SCRIPT_NAME:" not in text and needle in text:
    path.write_text(text.replace(needle, insert, 1))
    print("patched")
else:
    print("noop")
PY
fi
cd /opt/pgadmin
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --force-recreate
else
  docker-compose up -d --force-recreate
fi
echo PGADMIN_OK
`;
    await serverManagerService.executeCommand({ command: script, timeout: 180000 });
  }

  async repairInstalledRoutes(installed?: InstalledApp[]): Promise<void> {
    const list = installed || (await this.listInstalled());
    await this.repairCatalogContainers(list);
    await this.ensureCatalogApache(list);
  }

  async syncPublicRoutes(installed?: InstalledApp[], applicationSlugs: string[] = []): Promise<void> {
    const list = installed || (await this.listInstalled());
    const catalogPaths = this.getInstalledTunnelPaths(list);
    await cloudflareService.publishRoutes(applicationSlugs, catalogPaths);
  }

  private async ensureCatalogApache(installed: InstalledApp[]): Promise<void> {
    const managed = this.catalogApacheBlock(installed);
    const tmp = writeTemp('hub-catalog-apps', managed, '.conf');
    const py = writeTemp(
      'hub-catalog-patch',
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

    const shellQuote = (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const script = `#!/bin/bash
set -e
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
    const runner = writeTemp('hub-catalog-runner', script, '.sh');

    try {
      const wslRunner = toWslPath(runner);
      await serverManagerService.executeCommand({
        command: `bash ${shellQuote(wslRunner)} ${[
          APACHE_CONF,
          toWslPath(tmp),
          toWslPath(py),
          BEGIN_CATALOG_MARK,
          END_CATALOG_MARK,
        ]
          .map(shellQuote)
          .join(' ')}`,
        timeout: 60000,
      });
    } finally {
      try {
        fs.unlinkSync(tmp);
        fs.unlinkSync(py);
        fs.unlinkSync(runner);
      } catch {
        /* ignore */
      }
    }
  }

  async controlApp(
    appId: string,
    action: 'start' | 'stop' | 'restart',
    linuxUsername?: string,
    linuxPassword?: string
  ): Promise<{ success: boolean; message: string; output: string }> {
    const app = CATALOG.find((x) => x.id === appId);
    if (!app) throw new Error(`App não encontrado: ${appId}`);

    let cmd: string | undefined;
    if (action === 'start') cmd = app.startCommand;
    else if (action === 'stop') cmd = app.stopCommand;
    else if (action === 'restart') {
      cmd =
        app.restartCommand ||
        (app.stopCommand && app.startCommand ? `${app.stopCommand} ; sleep 1 ; ${app.startCommand}` : undefined);
    }

    if (!cmd) {
      throw new Error(`Ação "${action}" não suportada para o aplicativo ${app.name}`);
    }

    let res;
    if (app.requiresSudo && linuxPassword) {
      const { cmd: wrapped, stdin } = buildSudoWrappedCommand(cmd, linuxPassword);
      res = await serverManagerService.executeCommandStdin(
        { command: wrapped, timeout: 60000, username: linuxUsername },
        stdin
      );
    } else {
      res = await serverManagerService.executeCommand({
        command: cmd,
        timeout: 60000,
        username: linuxUsername,
      });
    }

    const output = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
    return {
      success: res.success || res.exitCode === 0,
      message:
        res.success || res.exitCode === 0
          ? `Aplicativo ${app.name} (${action}) executado com sucesso.`
          : `Falha ao executar ${action} em ${app.name}.`,
      output,
    };
  }

  async runDockerCompose(
    action: 'up' | 'down' | 'restart' | 'ps' | 'logs',
    composePath?: string,
    linuxUsername?: string,
    linuxPassword?: string
  ): Promise<{ success: boolean; message: string; output: string; exitCode: number }> {
    const safePath = (composePath || '').trim() || '.';
    let composeCmd = '';
    if (action === 'up') {
      composeCmd = `(docker compose up -d --build 2>&1 || docker-compose up -d --build 2>&1)`;
    } else if (action === 'down') {
      composeCmd = `(docker compose down 2>&1 || docker-compose down 2>&1)`;
    } else if (action === 'restart') {
      composeCmd = `(docker compose restart 2>&1 || docker-compose restart 2>&1)`;
    } else if (action === 'ps') {
      composeCmd = `(docker compose ps 2>&1 || docker-compose ps 2>&1)`;
    } else if (action === 'logs') {
      composeCmd = `(docker compose logs --tail 100 2>&1 || docker-compose logs --tail 100 2>&1)`;
    } else {
      throw new Error(`Ação docker compose "${action}" não suportada`);
    }

    const fullCmd =
      safePath !== '.'
        ? `mkdir -p ${shellSingleQuote(safePath)} 2>/dev/null; cd ${shellSingleQuote(safePath)} && ${composeCmd}`
        : composeCmd;

    let res;
    if (linuxPassword) {
      const { cmd: wrapped, stdin } = buildSudoWrappedCommand(fullCmd, linuxPassword);
      res = await serverManagerService.executeCommandStdin(
        { command: wrapped, timeout: 300000, username: linuxUsername },
        stdin
      );
    } else {
      res = await serverManagerService.executeCommand({
        command: fullCmd,
        timeout: 300000,
        username: linuxUsername,
      });
    }

    const output = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
    return {
      success: res.success || res.exitCode === 0,
      message:
        res.success || res.exitCode === 0
          ? `Comando docker compose ${action} executado com sucesso.`
          : `Erro ao executar docker compose ${action}.`,
      output,
      exitCode: res.exitCode,
    };
  }

  getJob(jobId: string): InstallJob | undefined {
    return this.jobs.get(jobId);
  }

  listJobs(): InstallJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  async startInstall(
    appId: string,
    linuxUsername?: string,
    linuxPassword?: string
  ): Promise<InstallJob> {
    const app = CATALOG.find((x) => x.id === appId);
    if (!app) throw new Error(`App não encontrado: ${appId}`);
    const jobId = randomBytes(8).toString('hex');

    const requiresSudo = !!app.requiresSudo;
    if (requiresSudo && (!linuxUsername || !linuxPassword)) {
      throw new Error(
        'Esta instalação requer uma sessão Linux autenticada. Faça login com seu usuário Linux e tente novamente.'
      );
    }
    if (linuxUsername && serverManagerService.getActiveServer().type === 'wsl') {
      const exists = await wslService.linuxUserExists(linuxUsername);
      if (!exists) {
        const currentLinuxUser = await wslService.getCurrentLinuxUser();
        throw new Error(
          currentLinuxUser
            ? `O usuário Linux "${linuxUsername}" não existe dentro do WSL Ubuntu. O usuário atual detectado é "${currentLinuxUser}". Abra o Terminal do WSL e rode "whoami" para confirmar o nome correto do usuário de login.`
            : `O usuário Linux "${linuxUsername}" não existe dentro do WSL Ubuntu. Abra o Terminal do WSL e rode "whoami" para descobrir o nome correto do usuário de login.`
        );
      }
    }
    const usingLinuxSession = !!linuxUsername && !!linuxPassword;

    const { cmd: wrappedCmd, stdin: stdinPayload } = buildSudoWrappedCommand(app.installCommand, linuxPassword);

    const job: InstallJob = {
      jobId,
      appId,
      status: 'running',
      startedAt: Date.now(),
      output: `Iniciando instalação de ${app.name}...\n` +
        (requiresSudo
          ? usingLinuxSession
            ? `🔑 Modo sudo ativado: usando a sessão Linux autenticada do usuário "${linuxUsername}".\n`
            : `⚠️  Esta instalação requer privilégios sudo.\n`
          : ``),
    };
    this.storeJob(job);
    persistJob(job);

    (async () => {
      try {
        let r;
        if (usingLinuxSession) {
          r = await serverManagerService.executeCommandStdin(
            { command: wrappedCmd, timeout: 30 * 60 * 1000, username: linuxUsername },
            stdinPayload
          );
        } else {
          r = await serverManagerService.executeCommand({
            command: app.installCommand,
            timeout: 30 * 60 * 1000,
            username: linuxUsername,
          });
        }
        const j = this.jobs.get(jobId)!;
        this.appendJobOutput(j, `\n---- STDOUT ----\n${r.stdout || ''}\n`);
        if (r.stderr) this.appendJobOutput(j, `\n---- STDERR ----\n${r.stderr}\n`);
        this.appendJobOutput(j, `\nCódigo saída: ${r.exitCode}\n`);

        const combined = `${r.stdout || ''}\n${r.stderr || ''}`.toLowerCase();
        const passwordPrompted =
          combined.includes('password for') ||
          combined.includes('sudo: a password is required') ||
          combined.includes('sudo: no tty present and no askpass program specified');
        const userNotFound =
          combined.includes('wsl_e_user_not_found') ||
          combined.includes('getpwnam(') ||
          combined.includes('usuário não encontrado') ||
          combined.includes('user not found');
        const permissionDenied =
          combined.includes('permission denied') ||
          combined.includes('could not open lock file') ||
          combined.includes('unable to lock directory') ||
          combined.includes('sudo: no password provided');

        const sudoAuthFailed =
          combined.includes('sudo_auth_failed') ||
          combined.includes('incorrect password') ||
          combined.includes('sorry, try again') ||
          (usingLinuxSession && !`${r.stdout || ''}`.includes('SUDO_AUTH_OK') && !r.success);

        j.status = r.success ? 'success' : r.exitCode === 0 ? 'success' : 'error';
        if (j.status === 'success') {
          if (userNotFound) {
            j.status = 'error';
            this.appendJobOutput(j, `\n👤 USUÁRIO LINUX INVÁLIDO: o nome do usuário autenticado não existe dentro do WSL Ubuntu.\n👉 Abra o Terminal do WSL, rode "whoami" e entre novamente com esse valor exato.`);
          } else if (sudoAuthFailed || permissionDenied) {
            j.status = 'error';
            this.appendJobOutput(j, `\n🔐 SUDO NECESSÁRIO: a instalação não conseguiu obter privilégios root.\n👉 Verifique se a senha usada no login do Linux também é válida para sudo e tente novamente.`);
          } else {
            this.appendJobOutput(j, `\n✅ Instalação concluída com sucesso!`);
            try {
              const installed = await this.listInstalled();
              await this.repairInstalledRoutes(installed);
              const { applicationsService } = await import('./applications.service');
              const slugs = applicationsService.list().map((app) => app.slug);
              const cf = await cloudflareService.publishRoutes(slugs, this.getInstalledTunnelPaths(installed));
              if (cf.message) {
                this.appendJobOutput(j, `\n🌐 ${cf.message}`);
              }
            } catch (routeErr: any) {
              this.appendJobOutput(j, `\n⚠️ Rotas públicas: ${routeErr?.message || routeErr}`);
            }
          }
        } else {
          if (userNotFound) {
            this.appendJobOutput(j, `\n👤 USUÁRIO LINUX INVÁLIDO:\n  • O nome do usuário autenticado não existe dentro da distro Ubuntu do WSL.\n  • Abra o Terminal do WSL e rode "whoami" para descobrir o nome correto.\n  • Depois entre novamente com esse usuário Linux.`);
          } else if (sudoAuthFailed || permissionDenied || passwordPrompted) {
            this.appendJobOutput(j, `\n🔐 FALHA DE SUDO:\n  • Esta aplicação requer privilégios sudo (root) para ser instalada.\n  • A senha usada no login Linux precisa autenticar no sudo.\n  • Entre novamente com a credencial Linux correta e repita a instalação.\nA senha fica apenas na sessão em memória do backend e não é exposta pela interface.`);
          } else {
            this.appendJobOutput(j, `\n⚠️  Instalação terminou com avisos/erros. Verifique a saída acima.`);
          }
        }
        j.finishedAt = Date.now();
        this.evictFinishedJobs();
        persistJob(j);
      } catch (e: any) {
        const j = this.jobs.get(jobId)!;
        j.status = 'error';
        j.error = e?.message || String(e);
        this.appendJobOutput(j, `\nERRO: ${j.error}\n`);
        j.finishedAt = Date.now();
        this.evictFinishedJobs();
        persistJob(j);
      }
    })();

    return job;
  }
}

export const appsService = new AppsService();
