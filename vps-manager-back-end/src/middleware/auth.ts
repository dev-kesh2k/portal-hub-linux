import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { userService, allScreensFull } from '../services/user.service';
import { AccessLevel, AuthUserSession, ScreenKey } from '../types';

const ENV_ROOT_ID = 'env-root';

function cleanSecret(value: string): string {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function getEnvRootUsername(): string {
  return cleanSecret(process.env.AUTH_USERNAME || '');
}

function envCredentialsMatch(username: string, password: string): boolean {
  const expectedUser = getEnvRootUsername();
  const expectedPass = cleanSecret(process.env.AUTH_PASSWORD || '');
  if (!expectedUser || !expectedPass) return false;
  if (cleanSecret(username).toLowerCase() !== expectedUser.toLowerCase()) return false;
  return secretsEqual(password, expectedPass);
}

function envRootSession(): AuthUserSession {
  const username = getEnvRootUsername() || 'root';
  return {
    id: ENV_ROOT_ID,
    username,
    role: 'admin',
    permissions: allScreensFull(),
    isEnvRoot: true,
  };
}

const TOKEN_VALIDITY_MS = 24 * 60 * 60 * 1000;

interface TokenStore {
  [token: string]: { session: AuthUserSession; exp: number; linuxPassword: string };
}

const tokens: TokenStore = {};

function generateToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

/**
 * Login do Hub:
 * 1) AUTH_USERNAME/AUTH_PASSWORD do .env → root do Hub (não é usuário Linux)
 * 2) Usuários criados na página Usuários → PostgreSQL
 */
export async function authenticateAndIssueToken(
  username: string,
  password: string
): Promise<{ token: string; session: AuthUserSession } | null> {
  username = cleanSecret(username);
  password = cleanSecret(password);
  if (!username || !password) return null;

  if (envCredentialsMatch(username, password)) {
    const session = envRootSession();
    const token = generateToken();
    tokens[token] = { session, exp: Date.now() + TOKEN_VALIDITY_MS, linuxPassword: '' };
    return { token, session };
  }

  // Root do .env não autentica pela tabela users
  const envUser = getEnvRootUsername();
  if (envUser && username.toLowerCase() === envUser.toLowerCase()) {
    console.warn(`Login recusado para root do .env (senha incorreta)`);
    return null;
  }

  const localUser = userService.getByUsername(username);
  if (!localUser || !userService.verifyPassword(password, localUser.passwordHash)) {
    console.warn(`Login recusado para "${username}"`);
    return null;
  }

  const session = userService.toSession(localUser);
  const token = generateToken();
  tokens[token] = { session, exp: Date.now() + TOKEN_VALIDITY_MS, linuxPassword: '' };
  return { token, session };
}

function getTokenEntry(token: string): { session: AuthUserSession; exp: number; linuxPassword: string } | null {
  const entry = tokens[token];
  if (!entry) return null;
  if (entry.exp < Date.now()) {
    delete tokens[token];
    return null;
  }
  return entry;
}

export function validateToken(token: string): AuthUserSession | null {
  return getTokenEntry(token)?.session || null;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const entry = getTokenEntry(token);
  if (!entry) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (entry.session.isEnvRoot || entry.session.id === ENV_ROOT_ID) {
    entry.session = envRootSession();
  } else {
    const latest =
      userService.getById(entry.session.id) || userService.getByUsername(entry.session.username);
    if (!latest) {
      delete tokens[token];
      res.status(401).json({ error: 'Usuário removido ou inválido' });
      return;
    }
    entry.session = userService.toSession(latest);
  }

  const session = entry.session;
  (req as any).user = session.username;
  (req as any).session = session;
  (req as any).authToken = token;
  (req as any).linuxPassword = entry.linuxPassword;
  next();
}

export function requirePermission(screen: ScreenKey, level: AccessLevel = 'read') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session: AuthUserSession | undefined = (req as any).session;
    if (!session) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!userService.canAccess(session, screen, level)) {
      res.status(403).json({ error: `Permissão negada: tela "${screen}" nível "${level}"` });
      return;
    }
    next();
  };
}

export function requireAnyPermission(screens: ScreenKey[], level: AccessLevel = 'read') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session: AuthUserSession | undefined = (req as any).session;
    if (!session) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const hasAccess = screens.some((screen) => userService.canAccess(session, screen, level));
    if (!hasAccess) {
      res.status(403).json({ error: `Permissão negada para telas: ${screens.join(', ')}` });
      return;
    }
    next();
  };
}

export function requireAdmin() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session: AuthUserSession | undefined = (req as any).session;
    if (!session) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (session.role !== 'admin' && !session.isEnvRoot) {
      res.status(403).json({ error: 'Requer privilégio de administrador' });
      return;
    }
    next();
  };
}

export function cleanupExpiredTokens(): void {
  const now = Date.now();
  Object.keys(tokens).forEach((t) => {
    if (tokens[t].exp < now) delete tokens[t];
  });
}

setInterval(cleanupExpiredTokens, 5 * 60 * 1000);

export function validateWsAuth(protocol: string | undefined): AuthUserSession | null {
  if (!protocol) return null;
  const parts = protocol.split(',').map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith('token-')) {
      const token = part.slice(6);
      return validateToken(token);
    }
  }
  return null;
}
