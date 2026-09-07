import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const commandSchema = z.object({
  command: z.string().min(1),
  workingDirectory: z.string().optional(),
  timeout: z.number().int().positive().max(1_800_000).optional(),
});

export const fileListSchema = z.object({
  path: z.string().default('/'),
});

export const serviceActionSchema = z.object({
  action: z.enum(['start', 'stop', 'restart', 'status']),
  service: z.string().min(1),
});

export const serverSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['wsl', 'ssh', 'local']),
  description: z.string().max(300).optional(),
  wslDistro: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().optional(),
  authType: z.enum(['password', 'key']).optional(),
  password: z.string().optional(),
  privateKey: z.string().optional(),
});

export const updateServerSchema = serverSchema.partial();

export const websiteSchema = z.object({
  name: z.string().min(1).max(80),
  url: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value), 'URL deve começar com http:// ou https://'),
  description: z.string().max(200).optional(),
});

export const updateWebsiteSchema = websiteSchema.partial();

export const screenKeySchema = z.enum([
  'dashboard',
  'terminal',
  'command',
  'services',
  'files',
  'logs',
  'appsInstalled',
  'users',
  'servers',
  'websites',
  'aplicacoes',
]);

export const permissionSchema = z.object({
  screen: screenKeySchema,
  level: z.enum(['read', 'full']),
});

export const createUserSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(4).max(256),
  role: z.enum(['admin', 'operator', 'viewer']).default('viewer'),
  permissions: z.array(permissionSchema).optional(),
});

export const updateUserSchema = z.object({
  password: z.string().min(4).max(256).optional(),
  role: z.enum(['admin', 'operator', 'viewer']).optional(),
  permissions: z.array(permissionSchema).optional(),
});

export const appControlSchema = z.object({
  action: z.enum(['start', 'stop', 'restart']),
});

export const dockerComposeSchema = z.object({
  action: z.enum(['up', 'down', 'restart', 'ps', 'logs']),
  composePath: z.string().optional(),
  appId: z.string().optional(),
});
