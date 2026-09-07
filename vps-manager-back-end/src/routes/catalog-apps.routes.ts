import { Router, Request, Response } from 'express';
import { authMiddleware, requireAnyPermission, requirePermission } from '../middleware/auth';
import { appsService, hubPublicOrigin } from '../services/apps.service';
import { ScreenKey } from '../types';
import { appControlSchema, dockerComposeSchema } from './shared/schemas';
import { getLinuxPassword, getSession } from './shared/session';

export const catalogAppsRoutes = Router();

catalogAppsRoutes.get(
  '/catalog',
  authMiddleware,
  requirePermission('command' as ScreenKey, 'read'),
  (_req: Request, res: Response) => {
    res.json({
      categories: appsService.getCategories(),
      apps: appsService.getCatalog(),
    });
  },
);

catalogAppsRoutes.get(
  '/installed',
  authMiddleware,
  requirePermission('appsInstalled' as ScreenKey, 'read'),
  async (_req: Request, res: Response) => {
    const list = await appsService.listInstalled();
    res.json({
      apps: list,
      categories: appsService.getCategories(),
      publicOrigin: hubPublicOrigin(),
    });
  },
);

catalogAppsRoutes.post(
  '/install/:appId',
  authMiddleware,
  requirePermission('command' as ScreenKey, 'full'),
  async (req: Request, res: Response) => {
    try {
      const session = getSession(req);
      const job = await appsService.startInstall(
        String(req.params.appId),
        session.username,
        getLinuxPassword(req),
      );
      res.json({ jobId: job.jobId, appId: job.appId, status: job.status, startedAt: job.startedAt });
    } catch (error: unknown) {
      const err = error as { message?: string; errors?: unknown };
      res.status(400).json({ error: err.message || 'Erro ao iniciar instalação', details: err.errors });
    }
  },
);

catalogAppsRoutes.get(
  '/jobs',
  authMiddleware,
  requirePermission('command' as ScreenKey, 'read'),
  (_req: Request, res: Response) => {
    res.json({ jobs: appsService.listJobs() });
  },
);

catalogAppsRoutes.get(
  '/jobs/:jobId',
  authMiddleware,
  requirePermission('command' as ScreenKey, 'read'),
  (req: Request, res: Response) => {
    const job = appsService.getJob(String(req.params.jobId));
    if (!job) {
      res.status(404).json({ error: 'Job não encontrado' });
      return;
    }
    res.json({ job });
  },
);

catalogAppsRoutes.post(
  '/action/:appId',
  authMiddleware,
  requireAnyPermission(['appsInstalled', 'command', 'services'], 'full'),
  async (req: Request, res: Response) => {
    try {
      const { action } = appControlSchema.parse(req.body);
      const session = getSession(req);
      const result = await appsService.controlApp(
        String(req.params.appId),
        action,
        session.username,
        getLinuxPassword(req),
      );
      res.json(result);
    } catch (error: unknown) {
      const err = error as { message?: string; errors?: unknown };
      res.status(400).json({ error: err.message || 'Erro ao executar ação no app', details: err.errors });
    }
  },
);

catalogAppsRoutes.post(
  '/compose',
  authMiddleware,
  requireAnyPermission(['appsInstalled', 'command'], 'full'),
  async (req: Request, res: Response) => {
    try {
      const body = dockerComposeSchema.parse(req.body);
      const session = getSession(req);

      let composePath = body.composePath;
      if (!composePath && body.appId) {
        const app = appsService.getCatalog().find((a) => a.id === body.appId);
        if (app?.composePath) composePath = app.composePath;
      }

      const result = await appsService.runDockerCompose(
        body.action,
        composePath,
        session.username,
        getLinuxPassword(req),
      );
      res.json(result);
    } catch (error: unknown) {
      const err = error as { message?: string; errors?: unknown };
      res.status(400).json({ error: err.message || 'Erro ao executar Docker Compose', details: err.errors });
    }
  },
);
