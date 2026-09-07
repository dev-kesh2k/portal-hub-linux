import { Request } from 'express';
import { AuthUserSession } from '../../types';

export function getSession(req: Request): AuthUserSession {
  return (req as Request & { session: AuthUserSession }).session;
}

export function getLinuxPassword(req: Request): string {
  return String((req as Request & { linuxPassword?: string }).linuxPassword || '');
}

/**
 * Credenciais para deploy no host.
 * Não usa session.username (pode ser AUTH_USERNAME do .env e não existir no Linux).
 * O backend já roda como o usuário WSL correto; username vazio evita `runuser -u …`.
 */
export function deployCreds(req: Request): { linuxUsername: string; linuxPassword: string } {
  return {
    linuxUsername: '',
    linuxPassword: getLinuxPassword(req),
  };
}
