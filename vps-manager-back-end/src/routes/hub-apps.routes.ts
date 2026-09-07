import { Router, Request, Response } from 'express';
import { authMiddleware, requirePermission } from '../middleware/auth';
import { applicationsService } from '../services/applications.service';
import { deployCreds } from './shared/session';
import { longTimeout, uploadFields, uploadedPath } from './shared/upload';

export const hubAppsRoutes = Router();

hubAppsRoutes.get('/', authMiddleware, requirePermission('aplicacoes', 'read'), (_req: Request, res: Response) => {
  res.json({
    applications: applicationsService.list(),
    publicOrigin: process.env.PUBLIC_ORIGIN || 'https://central-apps-hub.com.br',
  });
});

hubAppsRoutes.get('/ports', authMiddleware, requirePermission('aplicacoes', 'read'), async (_req: Request, res: Response) => {
  const ports = await applicationsService.listPorts();
  res.json({
    ports,
    pools: {
      backend: { start: 3100, end: 3199 },
      public: { start: 8100, end: 8199 },
    },
  });
});

hubAppsRoutes.post(
  '/',
  authMiddleware,
  requirePermission('aplicacoes', 'full'),
  longTimeout,
  uploadFields,
  async (req: Request, res: Response) => {
    try {
      const name = String(req.body?.name || '').trim();
      const description = String(req.body?.description || '').trim() || undefined;
      const application = await applicationsService.create({
        name,
        description,
        frontendZip: uploadedPath(req, 'frontend'),
        backendZip: uploadedPath(req, 'backend'),
        replicas: req.body?.replicas,
        memoryLimitMb: req.body?.memoryLimitMb,
        cpuLimit: req.body?.cpuLimit,
        ...deployCreds(req),
      });
      res.json({ application });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Falha ao publicar a aplicação';
      res.status(400).json({ error: message });
    }
  },
);

hubAppsRoutes.post(
  '/:id/upload',
  authMiddleware,
  requirePermission('aplicacoes', 'full'),
  longTimeout,
  uploadFields,
  async (req: Request, res: Response) => {
    try {
      const application = await applicationsService.addFiles(req.params.id, {
        frontendZip: uploadedPath(req, 'frontend'),
        backendZip: uploadedPath(req, 'backend'),
        replicas: req.body?.replicas,
        memoryLimitMb: req.body?.memoryLimitMb,
        cpuLimit: req.body?.cpuLimit,
        ...deployCreds(req),
      });
      res.json({ application });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Falha ao atualizar a aplicação';
      res.status(400).json({ error: message });
    }
  },
);

hubAppsRoutes.post(
  '/:id/cloudflare',
  authMiddleware,
  requirePermission('aplicacoes', 'full'),
  longTimeout,
  async (req: Request, res: Response) => {
    try {
      const application = await applicationsService.publishCloudflare(req.params.id);
      res.json({ application });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Falha ao publicar no Cloudflare';
      res.status(400).json({ error: message });
    }
  },
);

hubAppsRoutes.post(
  '/:id/scale',
  authMiddleware,
  requirePermission('aplicacoes', 'full'),
  longTimeout,
  async (req: Request, res: Response) => {
    try {
      const application = await applicationsService.updateScale(req.params.id, {
        replicas: req.body?.replicas,
        memoryLimitMb: req.body?.memoryLimitMb,
        cpuLimit: req.body?.cpuLimit === null || req.body?.cpuLimit === '' ? null : req.body?.cpuLimit,
        autoScaleEnabled: req.body?.autoScaleEnabled,
        autoScaleMin: req.body?.autoScaleMin,
        autoScaleMax: req.body?.autoScaleMax,
        autoScaleCpuUp: req.body?.autoScaleCpuUp,
        autoScaleMemUp: req.body?.autoScaleMemUp,
        autoScaleCpuDown: req.body?.autoScaleCpuDown,
        autoScaleMemDown: req.body?.autoScaleMemDown,
        ...deployCreds(req),
      });
      res.json({ application });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Falha ao ajustar réplicas';
      res.status(400).json({ error: message });
    }
  },
);

hubAppsRoutes.post(
  '/:id/redeploy',
  authMiddleware,
  requirePermission('aplicacoes', 'full'),
  longTimeout,
  async (req: Request, res: Response) => {
    try {
      const application = await applicationsService.redeploy(req.params.id, deployCreds(req));
      res.json({ application });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Falha ao reconfigurar a aplicação';
      res.status(400).json({ error: message });
    }
  },
);

hubAppsRoutes.delete(
  '/:id',
  authMiddleware,
  requirePermission('aplicacoes', 'full'),
  longTimeout,
  async (req: Request, res: Response) => {
    try {
      await applicationsService.remove(req.params.id, deployCreds(req));
      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Erro ao remover aplicação';
      res.status(400).json({ error: message });
    }
  },
);
