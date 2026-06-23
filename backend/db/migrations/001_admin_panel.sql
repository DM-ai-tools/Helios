-- ============================================================
-- 001_admin_panel.sql — Admin Panel foundation
-- Idempotent: safe to run multiple times.
-- Adds RBAC + lifecycle columns to users, metadata to plugins,
-- and an admin_config table for runtime/persisted env overrides.
-- ============================================================

-- ─── USERS: role / status / plan / lifecycle ──────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS role         TEXT DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status       TEXT DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan         TEXT DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS metadata     JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- Bootstrap: the platform owner is an admin.
UPDATE users SET role = 'admin' WHERE email = 'tools1.dotmappers@gmail.com';

-- ─── PLUGINS: presentation metadata + ordering + run flag ─────
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS category        TEXT;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS icon            TEXT;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS prompt_template TEXT;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS display_order   INT DEFAULT 0;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS is_executable   BOOLEAN DEFAULT FALSE;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_plugins_display_order ON plugins(display_order);

-- Backfill metadata for the 6 code-backed plugins (only where unset).
UPDATE plugins SET category = COALESCE(category, 'SEO & Search'),  icon = COALESCE(icon, '🔍'), display_order = 1, is_executable = TRUE WHERE id = 'seo-audit';
UPDATE plugins SET category = COALESCE(category, 'Strategy'),       icon = COALESCE(icon, '🎯'), display_order = 2, is_executable = TRUE WHERE id = 'competitive-brief';
UPDATE plugins SET category = COALESCE(category, 'Strategy'),       icon = COALESCE(icon, '📅'), display_order = 3, is_executable = TRUE WHERE id = 'campaign-plan';
UPDATE plugins SET category = COALESCE(category, 'Content'),        icon = COALESCE(icon, '✍️'), display_order = 4, is_executable = TRUE WHERE id = 'content-copy';
UPDATE plugins SET category = COALESCE(category, 'Content'),        icon = COALESCE(icon, '📧'), display_order = 5, is_executable = TRUE WHERE id = 'email-sequence';
UPDATE plugins SET category = COALESCE(category, 'Brand & Compliance'), icon = COALESCE(icon, '🛡️'), display_order = 6, is_executable = TRUE WHERE id = 'brand-review';

-- ─── ADMIN CONFIG: persisted env-var overrides ────────────────
-- Durable across restarts/redeploys (the .env file is best-effort and
-- ephemeral on Railway). Values for secret keys are stored encrypted via
-- cryptoService; non-secrets are stored in plain text.
CREATE TABLE IF NOT EXISTS admin_config (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  category    TEXT,
  description TEXT,
  is_secret   BOOLEAN DEFAULT FALSE,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  TEXT
);
