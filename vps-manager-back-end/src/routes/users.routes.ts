import { Router, Request, Response } from 'express';
import { authMiddleware, requireAdmin, getEnvRootUsername } from '../middleware/auth';
import { userService } from '../services/user.service';
import { wslService } from '../services/wsl.service';
import { ScreenPermission } from '../types';
import { createUserSchema, updateUserSchema } from './shared/schemas';
import { getLinuxPassword, getSession } from './shared/session';

export const usersRoutes = Router();

usersRoutes.get('/', authMiddleware, requireAdmin(), (_req: Request, res: Response) => {
  res.json({
    users: userService.listAll(),
    screens: userService.listScreensMeta(),
    envRootUsername: getEnvRootUsername() || null,
  });
});

usersRoutes.post('/', authMiddleware, requireAdmin(), async (req: Request, res: Response) => {
  try {
    const body = createUserSchema.parse(req.body);
    const session = getSession(req);
    const actorPassword = getLinuxPassword(req);
    const grantSudo = body.role === 'admin';

    await userService.createLinuxUserAs(
      session.username,
      actorPassword,
      body.username,
      body.password,
      grantSudo
    );

    try {
      const created = userService.create({
        username: body.username,
        password: body.password,
        role: body.role,
        permissions: body.permissions as ScreenPermission[] | undefined,
      });
      res.json({ user: created, linux: { created: true, sudo: grantSudo } });
    } catch (dbError) {
      try {
        await userService.deleteLinuxUserAs(session.username, actorPassword, body.username);
      } catch (rollbackErr) {
        console.warn('Rollback Linux após falha no banco:', rollbackErr);
      }
      throw dbError;
    }
  } catch (error: unknown) {
    const err = error as { message?: string; errors?: unknown };
    res.status(400).json({ error: err.message || 'Dados inválidos', details: err.errors });
  }
});

usersRoutes.put('/:id', authMiddleware, requireAdmin(), async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const body = updateUserSchema.parse(req.body);
    const target = userService.getById(id);
    if (!target) throw new Error('Usuário não encontrado');

    const session = getSession(req);
    const actorPassword = getLinuxPassword(req);
    const nextRole = body.role ?? target.role;
    const grantSudo = nextRole === 'admin';
    const roleChanged = body.role !== undefined && body.role !== target.role;
    const linuxExists = await wslService.linuxUserExists(target.username);

    if (!linuxExists) {
      if (!body.password) {
        throw new Error(
          `O usuário "${target.username}" ainda não existe no Linux. Informe uma senha ao salvar para criar a conta Linux.`
        );
      }
      await userService.createLinuxUserAs(
        session.username,
        actorPassword,
        target.username,
        body.password,
        grantSudo
      );
    } else {
      if (body.password) {
        await userService.updateLinuxPasswordAs(
          session.username,
          actorPassword,
          target.username,
          body.password
        );
      }
      if (roleChanged || grantSudo) {
        await userService.setLinuxSudoAs(
          session.username,
          actorPassword,
          target.username,
          grantSudo
        );
      }
    }

    const updated = userService.update(id, {
      password: body.password,
      role: body.role,
      permissions: body.permissions as ScreenPermission[] | undefined,
    });
    res.json({ user: updated, linux: { sudo: grantSudo } });
  } catch (error: unknown) {
    const err = error as { message?: string; errors?: unknown };
    res.status(400).json({ error: err.message || 'Dados inválidos', details: err.errors });
  }
});

usersRoutes.delete('/:id', authMiddleware, requireAdmin(), async (req: Request, res: Response) => {
  try {
    const session = getSession(req);
    const removed = userService.delete(req.params.id, session.id);
    try {
      await userService.deleteLinuxUserAs(session.username, getLinuxPassword(req), removed.username);
    } catch (linuxErr) {
      console.warn('Usuário removido do Hub, mas falhou no Linux:', linuxErr);
      const message = linuxErr instanceof Error ? linuxErr.message : String(linuxErr);
      res.json({ ok: true, linuxWarning: message });
      return;
    }
    res.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao excluir';
    res.status(400).json({ error: message });
  }
});
