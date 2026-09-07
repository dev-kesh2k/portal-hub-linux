import { Router, Request, Response } from 'express';
import { authMiddleware, requireAnyPermission, requirePermission } from '../middleware/auth';
import { serverManagerService } from '../services/server-manager.service';
import { serverSchema, updateServerSchema } from './shared/schemas';

export const serversRoutes = Router();

serversRoutes.get('/', authMiddleware, (_req: Request, res: Response) => {
  const servers = serverManagerService.listServers();
  const active = serverManagerService.getActiveServerPublic();
  res.json({ servers, activeServerId: active.id, active });
});

serversRoutes.get('/active', authMiddleware, (_req: Request, res: Response) => {
  const active = serverManagerService.getActiveServerPublic();
  res.json({ active });
});

serversRoutes.post(
  '/active/:id',
  authMiddleware,
  requireAnyPermission(['servers', 'dashboard'], 'read'),
  (req: Request, res: Response) => {
    try {
      const active = serverManagerService.setActiveServer(req.params.id);
      res.json({ success: true, active });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Erro ao alterar servidor ativo';
      res.status(400).json({ error: message });
    }
  },
);

serversRoutes.post('/', authMiddleware, requirePermission('servers', 'full'), (req: Request, res: Response) => {
  try {
    const body = serverSchema.parse(req.body);
    const created = serverManagerService.addServer(body as Parameters<typeof serverManagerService.addServer>[0]);
    res.json({ server: created });
  } catch (error: unknown) {
    const err = error as { message?: string; errors?: unknown };
    res.status(400).json({ error: err.message || 'Dados inválidos', details: err.errors });
  }
});

serversRoutes.put('/:id', authMiddleware, requirePermission('servers', 'full'), (req: Request, res: Response) => {
  try {
    const body = updateServerSchema.parse(req.body);
    const updated = serverManagerService.updateServer(req.params.id, body);
    res.json({ server: updated });
  } catch (error: unknown) {
    const err = error as { message?: string; errors?: unknown };
    res.status(400).json({ error: err.message || 'Dados inválidos', details: err.errors });
  }
});

serversRoutes.delete('/:id', authMiddleware, requirePermission('servers', 'full'), (req: Request, res: Response) => {
  try {
    serverManagerService.deleteServer(req.params.id);
    res.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao remover servidor';
    res.status(400).json({ error: message });
  }
});

serversRoutes.post(
  '/test',
  authMiddleware,
  requireAnyPermission(['servers', 'dashboard'], 'read'),
  async (req: Request, res: Response) => {
    try {
      const result = await serverManagerService.testConnection(req.body);
      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Erro no teste de conexão';
      res.status(400).json({ success: false, message });
    }
  },
);
