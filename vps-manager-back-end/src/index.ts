import './load-env';
import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { apiRouter } from './routes/api';
import { setupWebSocketServer } from './websocket/terminal';
import { initDatabase } from './db/init';
import { pruneOldInstallJobs } from './db/store';
import { databaseHealth } from './db/pool';
import { userService } from './services/user.service';
import { serverManagerService } from './services/server-manager.service';
import { websitesService } from './services/websites.service';
import { applicationsService } from './services/applications.service';
import { cloudflareService } from './services/cloudflare.service';
import { appsService } from './services/apps.service';
import { autoScaleService } from './services/auto-scale.service';

const PORT = parseInt(process.env.PORT || '3001');
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

const app = express();
const server = http.createServer(app);

app.use(
  cors({
    origin: (origin, cb) => {
      if (
        !origin ||
        origin === CORS_ORIGIN ||
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:') ||
        origin.includes('100.') ||
        origin.includes('.ts.net') ||
        origin.includes('vps-hub.com.br') ||
        origin.includes('central-apps-hub.com.br')
      ) {
        cb(null, true);
      } else {
        cb(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', async (_req, res) => {
  const database = await databaseHealth();
  res.json({
    status: database.status === 'ok' ? 'ok' : 'degraded',
    uptime: process.uptime(),
    pid: process.pid,
    database,
  });
});

app.use('/api', apiRouter);

const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|ws|health).*/, (_req, res) => {
    const indexPath = path.join(webDist, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send('Not found');
    }
  });
}

setupWebSocketServer(server);

async function start(): Promise<void> {
  await initDatabase();
  const prunedJobs = await pruneOldInstallJobs();
  if (prunedJobs > 0) {
    console.log(`PostgreSQL: ${prunedJobs} install job(s) antigo(s) removido(s)`);
  }
  await userService.reload();
  await serverManagerService.reload();
  await websitesService.reload();
  await applicationsService.reload();
  await appsService.reloadInstallJobs();
  try {
    await applicationsService.repairRoutes();
    console.log('Apache: rotas das aplicações sincronizadas');
  } catch (err: any) {
    console.warn('Apache: não foi possível sincronizar rotas:', err?.message || err);
  }
  try {
    const installed = await appsService.listInstalled();
    await appsService.repairInstalledRoutes(installed);
    await cloudflareService.publishRoutes(
      applicationsService.list().map((app) => app.slug),
      appsService.getInstalledTunnelPaths(installed)
    );
    console.log('Cloudflare: rotas do túnel sincronizadas');
  } catch (err: any) {
    console.warn('Cloudflare: não foi possível sincronizar o túnel:', err?.message || err);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('========================================');
    console.log('   WSL SERVER MANAGER - BACKEND');
    console.log('========================================');
    console.log(`HTTP API:     http://localhost:${PORT}`);
    console.log(`WebSocket:    ws://localhost:${PORT}/ws/terminal`);
    console.log(`WSL Distro:   ${process.env.WSL_DISTRO || 'Ubuntu'}`);
    console.log(`PostgreSQL:   ${process.env.DATABASE_NAME || 'central_apps_hub'}`);
    console.log(
      `Login:        ${process.env.AUTH_USERNAME ? `AUTH_USERNAME=${process.env.AUTH_USERNAME}` : 'usuário Linux'} + senha`
    );
    console.log('========================================');
    console.log('');
    autoScaleService.start();
  });
}

start().catch((err) => {
  console.error('Falha ao iniciar o backend:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});
