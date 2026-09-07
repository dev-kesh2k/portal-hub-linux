import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requirePermission } from '../middleware/auth';
import { assertSafeAbsolutePath, assertSafeServiceName } from '../lib/path-security';
import { serverManagerService } from '../services/server-manager.service';
import { commandSchema, fileListSchema, serviceActionSchema } from './shared/schemas';

export const systemRoutes = Router();

systemRoutes.post('/command', authMiddleware, requirePermission('command', 'full'), async (req: Request, res: Response) => {
  try {
    const body = commandSchema.parse(req.body);
    const result = await serverManagerService.executeCommand(body as Parameters<typeof serverManagerService.executeCommand>[0]);
    res.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid request';
    res.status(400).json({
      success: false,
      stdout: '',
      stderr: message,
      exitCode: -1,
      executionTimeMs: 0,
      command: (req.body as { command?: string })?.command || '',
    });
  }
});

systemRoutes.get('/wsl/info', authMiddleware, requirePermission('dashboard', 'read'), async (_req: Request, res: Response) => {
  const info = await serverManagerService.getServerInfo();
  res.json(info);
});

systemRoutes.get('/wsl/stats', authMiddleware, requirePermission('dashboard', 'read'), async (_req: Request, res: Response) => {
  const stats = await serverManagerService.getSystemStats();
  res.json(stats);
});

systemRoutes.get('/services', authMiddleware, requirePermission('services', 'read'), async (_req: Request, res: Response) => {
  const services = await serverManagerService.listRunningServices();
  res.json(services);
});

systemRoutes.post('/services/action', authMiddleware, requirePermission('services', 'full'), async (req: Request, res: Response) => {
  try {
    const { action, service } = serviceActionSchema.parse(req.body);
    const safeService = assertSafeServiceName(service);
    const cmd = `(systemctl ${action} "${safeService}" 2>&1 || service "${safeService}" ${action} 2>&1) && echo "ACTION_OK"`;
    const result = await serverManagerService.executeCommand({ command: cmd, timeout: 30000 });
    res.json({
      success: result.stdout.includes('ACTION_OK'),
      output: result.stdout.replace('ACTION_OK\n', '').replace('ACTION_OK', ''),
      stderr: result.stderr,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid request';
    res.status(400).json({ error: message });
  }
});

systemRoutes.get('/logs', authMiddleware, requirePermission('logs', 'read'), async (req: Request, res: Response) => {
  const rows = Math.min(parseInt((req.query.rows as string) || '100', 10), 1000);
  const logs = await serverManagerService.getRecentLogs(rows);
  res.json({ logs });
});

systemRoutes.get('/files', authMiddleware, requirePermission('files', 'read'), async (req: Request, res: Response) => {
  try {
    const { path: filePath } = fileListSchema.parse({ path: req.query.path });
    const safePath = assertSafeAbsolutePath(filePath);
    const files = await serverManagerService.listFiles(safePath);
    res.json({ path: safePath, files });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid request';
    res.status(400).json({ error: message });
  }
});

systemRoutes.post('/files/read', authMiddleware, requirePermission('files', 'read'), async (req: Request, res: Response) => {
  try {
    const { path: filePath } = z.object({ path: z.string().min(1) }).parse(req.body);
    const safePath = assertSafeAbsolutePath(filePath);
    const result = await serverManagerService.executeCommand({
      command: `wc -l "${safePath}" 2>&1 | awk '{print $1}'`,
    });
    const lineCount = parseInt(result.stdout.trim(), 10);
    const headCmd = lineCount > 2000 ? `head -n 2000 "${safePath}"` : `cat "${safePath}"`;
    const contentResult = await serverManagerService.executeCommand({ command: headCmd, timeout: 15000 });
    res.json({
      path: safePath,
      content: contentResult.stdout,
      truncated: lineCount > 2000,
      totalLines: Number.isNaN(lineCount) ? 0 : lineCount,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid request';
    res.status(400).json({ error: message });
  }
});
