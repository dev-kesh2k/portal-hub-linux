import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import os from 'os';

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, file, cb) => {
    const original = String(file.originalname || 'upload.zip').toLowerCase();
    const ext = original.endsWith('.tar.gz')
      ? '.tar.gz'
      : original.endsWith('.tgz')
        ? '.tgz'
        : original.endsWith('.tar')
          ? '.tar'
          : '.zip';
    cb(null, `hub-upload-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
  },
});

const archiveUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: 200 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    const ok =
      name.endsWith('.zip') || name.endsWith('.tar.gz') || name.endsWith('.tgz') || name.endsWith('.tar');
    if (!ok) {
      cb(new Error('Envie um arquivo .zip ou .tar.gz'));
      return;
    }
    cb(null, true);
  },
});

export function uploadFields(req: Request, res: Response, next: NextFunction): void {
  archiveUpload.fields([
    { name: 'frontend', maxCount: 1 },
    { name: 'backend', maxCount: 1 },
  ])(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Falha no upload';
      res.status(400).json({ error: message });
      return;
    }
    next();
  });
}

export function uploadedPath(req: Request, field: 'frontend' | 'backend'): string | undefined {
  const files = req.files as { [key: string]: Express.Multer.File[] } | undefined;
  return files?.[field]?.[0]?.path;
}

export function longTimeout(req: Request, res: Response, next: NextFunction): void {
  req.setTimeout(300000);
  res.setTimeout(300000);
  next();
}
