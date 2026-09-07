import { Router, Request, Response } from 'express';
import { authMiddleware, requirePermission } from '../middleware/auth';
import { websitesService } from '../services/websites.service';
import { updateWebsiteSchema, websiteSchema } from './shared/schemas';

export const websitesRoutes = Router();

websitesRoutes.get('/', authMiddleware, requirePermission('websites', 'read'), (_req: Request, res: Response) => {
  res.json({ websites: websitesService.list() });
});

websitesRoutes.post('/', authMiddleware, requirePermission('websites', 'full'), (req: Request, res: Response) => {
  try {
    const body = websiteSchema.parse(req.body);
    const website = websitesService.create(body as Parameters<typeof websitesService.create>[0]);
    res.json({ website });
  } catch (error: unknown) {
    const err = error as { message?: string; errors?: unknown };
    res.status(400).json({ error: err.message || 'Dados inválidos', details: err.errors });
  }
});

websitesRoutes.put('/:id', authMiddleware, requirePermission('websites', 'full'), (req: Request, res: Response) => {
  try {
    const body = updateWebsiteSchema.parse(req.body);
    const website = websitesService.update(req.params.id, body);
    res.json({ website });
  } catch (error: unknown) {
    const err = error as { message?: string; errors?: unknown };
    res.status(400).json({ error: err.message || 'Dados inválidos', details: err.errors });
  }
});

websitesRoutes.delete('/:id', authMiddleware, requirePermission('websites', 'full'), (req: Request, res: Response) => {
  try {
    websitesService.delete(req.params.id);
    res.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao remover site';
    res.status(400).json({ error: message });
  }
});
