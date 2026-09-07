import { Router, Request, Response } from 'express';
import { authenticateAndIssueToken, authMiddleware } from '../middleware/auth';
import { clearLoginFailures, loginRateLimit, recordLoginFailure } from '../middleware/login-rate-limit';
import { userService } from '../services/user.service';
import { loginSchema } from './shared/schemas';
import { getSession } from './shared/session';

export const authRoutes = Router();

authRoutes.post('/login', loginRateLimit, async (req: Request, res: Response) => {
  try {
    const { username, password } = loginSchema.parse(req.body);
    const auth = await authenticateAndIssueToken(username, password);
    if (!auth) {
      recordLoginFailure(req);
      res.status(401).json({
        error: 'Credenciais inválidas. Use o root do Hub (AUTH_USERNAME no .env) ou um usuário criado em Usuários.',
      });
      return;
    }
    clearLoginFailures(req);
    res.json({
      token: auth.token,
      user: auth.session.username,
      id: auth.session.id,
      role: auth.session.role,
      permissions: auth.session.permissions,
      isEnvRoot: !!auth.session.isEnvRoot,
      expiresIn: '24h',
    });
  } catch (error) {
    if ((error as { name?: string })?.name === 'ZodError') {
      res.status(400).json({ error: 'Corpo da requisição inválido', details: (error as { errors?: unknown }).errors });
      return;
    }
    console.error('Falha no login:', error);
    res.status(500).json({
      error: 'Não foi possível autenticar. Verifique o backend e o PostgreSQL.',
    });
  }
});

authRoutes.get('/me', authMiddleware, (req: Request, res: Response) => {
  const session = getSession(req);
  res.json({
    id: session.id,
    user: session.username,
    role: session.role,
    permissions: session.permissions,
    isEnvRoot: !!session.isEnvRoot,
  });
});

authRoutes.get('/screens', authMiddleware, (_req: Request, res: Response) => {
  res.json({ screens: userService.listScreensMeta() });
});
