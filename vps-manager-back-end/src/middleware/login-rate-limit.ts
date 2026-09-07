import { Request, Response, NextFunction } from 'express';

const MAX_FAILS = 10;
const BLOCK_MS = 15 * 60 * 1000;

interface Bucket {
  fails: number;
  blockedUntil: number;
}

const buckets = new Map<string, Bucket>();

function clientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]?.trim() || req.ip || 'unknown';
  }
  return req.ip || 'unknown';
}

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = clientKey(req);
  const bucket = buckets.get(key);
  if (bucket && bucket.blockedUntil > Date.now()) {
    res.status(429).json({ error: 'Muitas tentativas de login. Aguarde alguns minutos.' });
    return;
  }
  (req as Request & { loginRateKey?: string }).loginRateKey = key;
  next();
}

export function recordLoginFailure(req: Request): void {
  const key = (req as Request & { loginRateKey?: string }).loginRateKey || clientKey(req);
  const now = Date.now();
  const current = buckets.get(key) || { fails: 0, blockedUntil: 0 };
  if (current.blockedUntil > 0 && current.blockedUntil <= now) {
    current.fails = 0;
    current.blockedUntil = 0;
  }
  current.fails += 1;
  if (current.fails >= MAX_FAILS) {
    current.blockedUntil = now + BLOCK_MS;
    current.fails = 0;
  }
  buckets.set(key, current);
}

export function clearLoginFailures(req: Request): void {
  const key = (req as Request & { loginRateKey?: string }).loginRateKey || clientKey(req);
  buckets.delete(key);
}
