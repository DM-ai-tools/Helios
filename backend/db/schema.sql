-- ============================================================
-- ClickTrends AI Audit — PostgreSQL Schema
-- Run: psql -U your_user -d your_db -f schema.sql
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- PLUGINS (static registry)
-- Seeded below — mirrors the backend plugin files
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plugins (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  description               TEXT,
  estimated_runtime_seconds INT DEFAULT 30,
  is_active                 BOOLEAN DEFAULT TRUE,
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

-- Seed plugin registry
INSERT INTO plugins (id, name, description, estimated_runtime_seconds) VALUES
  ('seo-audit',         'SEO Audit',         'Keyword, on-page, technical, gap and competitor analysis — prioritised action plan.', 45),
  ('competitive-brief', 'Competitive Brief',  'Positioning, messaging, content gaps. Powers pitch decks and battlecards.',           35),
  ('campaign-plan',     'Campaign Plan',      'Full brief with audience, channel mix, week-by-week calendar and metrics.',           40),
  ('content-copy',      'Content & Copy',     'Blog, social, ads, landing pages, case studies — channel-specific, on-brand.',        50),
  ('email-sequence',    'Email Sequence',     'Nurture, onboarding, win-back, launch flows — copy, timing and branching.',           35),
  ('brand-review',      'Brand Review',       'Checks voice, claims and legal flags before publish, with before/after fixes.',       25)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────
-- AUDITS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  url               TEXT NOT NULL,
  industry          TEXT,
  status            TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending','running','complete','failed')),
  overall_score     INT CHECK (overall_score BETWEEN 0 AND 100),
  executive_summary TEXT,
  report_url        TEXT,
  docx_url          TEXT,
  public_token      TEXT UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  crawled_data      JSONB,
  synthesis         JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_audits_user_id   ON audits(user_id);
CREATE INDEX IF NOT EXISTS idx_audits_status     ON audits(status);
CREATE INDEX IF NOT EXISTS idx_audits_public_token ON audits(public_token);

-- ─────────────────────────────────────────────
-- AUDIT PLUGINS (per-plugin execution results)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_plugins (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id         UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  plugin_id        TEXT NOT NULL REFERENCES plugins(id),
  status           TEXT DEFAULT 'queued'
                   CHECK (status IN ('queued','running','complete','failed')),
  score            INT CHECK (score BETWEEN 0 AND 100),
  claude_output    JSONB,         -- Raw parsed Claude response
  summary          TEXT,          -- Human-readable plugin summary
  recommendations  JSONB,         -- Array of recommendation objects
  error_message    TEXT,          -- If status = 'failed'
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  UNIQUE (audit_id, plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_plugins_audit_id   ON audit_plugins(audit_id);
CREATE INDEX IF NOT EXISTS idx_audit_plugins_plugin_id  ON audit_plugins(plugin_id);
CREATE INDEX IF NOT EXISTS idx_audit_plugins_status     ON audit_plugins(status);

-- ─────────────────────────────────────────────
-- REPORTS (generated output files)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id     UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  format       TEXT NOT NULL CHECK (format IN ('html','docx','pdf')),
  storage_url  TEXT,
  public_token TEXT UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  expires_at   TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_audit_id ON reports(audit_id);
CREATE INDEX IF NOT EXISTS idx_reports_token    ON reports(public_token);
