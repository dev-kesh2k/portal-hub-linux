CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  screen TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('read', 'full')),
  PRIMARY KEY (user_id, screen)
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('wsl', 'ssh', 'local')),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT,
  description TEXT,
  wsl_distro TEXT,
  host TEXT,
  port INTEGER,
  username TEXT,
  auth_type TEXT,
  password TEXT,
  private_key TEXT,
  created_at BIGINT NOT NULL,
  last_connected_at BIGINT,
  last_error TEXT,
  distro TEXT,
  kernel TEXT,
  uptime TEXT
);

CREATE TABLE IF NOT EXISTS websites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS hub_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS hub_applications (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  has_frontend BOOLEAN NOT NULL DEFAULT FALSE,
  has_backend BOOLEAN NOT NULL DEFAULT FALSE,
  frontend_path TEXT,
  backend_path TEXT,
  backend_port INTEGER,
  public_port INTEGER,
  frontend_url TEXT,
  backend_url TEXT,
  public_url TEXT,
  nginx_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  nginx_message TEXT,
  cloudflare_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  cloudflare_message TEXT,
  status TEXT NOT NULL CHECK (status IN ('deploying', 'active', 'error')),
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

ALTER TABLE hub_applications ADD COLUMN IF NOT EXISTS cloudflare_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE hub_applications ADD COLUMN IF NOT EXISTS cloudflare_message TEXT;
ALTER TABLE hub_applications ADD COLUMN IF NOT EXISTS replicas INTEGER NOT NULL DEFAULT 1;
ALTER TABLE hub_applications ADD COLUMN IF NOT EXISTS memory_limit_mb INTEGER NOT NULL DEFAULT 512;
ALTER TABLE hub_applications ADD COLUMN IF NOT EXISTS cpu_limit DOUBLE PRECISION;
ALTER TABLE hub_applications ADD COLUMN IF NOT EXISTS auto_scale_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE hub_applications ADD COLUMN IF NOT EXISTS auto_scale_min INTEGER NOT NULL DEFAULT 1;
ALTER TABLE hub_applications ADD COLUMN IF NOT EXISTS auto_scale_max INTEGER NOT NULL DEFAULT 3;
ALTER TABLE hub_applications ADD COLUMN IF NOT EXISTS auto_scale_cpu_up INTEGER NOT NULL DEFAULT 70;
ALTER TABLE hub_applications ADD COLUMN IF NOT EXISTS auto_scale_mem_up INTEGER NOT NULL DEFAULT 80;
ALTER TABLE hub_applications ADD COLUMN IF NOT EXISTS auto_scale_cpu_down INTEGER NOT NULL DEFAULT 25;
ALTER TABLE hub_applications ADD COLUMN IF NOT EXISTS auto_scale_mem_down INTEGER NOT NULL DEFAULT 40;
ALTER TABLE hub_applications ADD COLUMN IF NOT EXISTS last_scale_at BIGINT;

CREATE TABLE IF NOT EXISTS install_jobs (
  job_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  output TEXT NOT NULL DEFAULT '',
  error TEXT
);
