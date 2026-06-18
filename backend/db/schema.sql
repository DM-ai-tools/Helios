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
  password_hash TEXT NOT NULL,
  full_name    TEXT,
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

-- ─────────────────────────────────────────────
-- BUSINESS INTEGRATIONS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_integrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   TEXT NOT NULL,
  platform      TEXT NOT NULL,
  account_name  TEXT,
  account_id    TEXT,
  access_token  TEXT,
  refresh_token TEXT,
  token_expiry  TIMESTAMPTZ,
  status        TEXT DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'reauth')),
  metadata      JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (business_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_business_integrations_business_platform ON business_integrations(business_id, platform);

-- ─────────────────────────────────────────────
-- DEPLOYMENT JOBS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deployment_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT,
  audit_id    TEXT,
  change_id   TEXT,
  platform    TEXT NOT NULL,
  asset_type  TEXT,
  status      TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'deploying', 'completed', 'failed')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- DEPLOYMENTS (Rollback & Version Storage)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deployments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      TEXT,
  audit_id         TEXT,
  change_id        TEXT,
  platform         TEXT NOT NULL,
  asset_type       TEXT,
  content_payload  JSONB NOT NULL,
  previous_content JSONB,
  status           TEXT NOT NULL CHECK (status IN ('queued', 'deploying', 'completed', 'failed')),
  deployed_by      TEXT NOT NULL,
  response         JSONB,
  builder_type     TEXT,
  deployment_method TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deployments_business ON deployments(business_id);

-- ─────────────────────────────────────────────
-- AUDIT TRAIL
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_trail (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    TEXT,
  event_type     TEXT NOT NULL, -- e.g., 'approve', 'deploy', 'rollback', 'disconnect'
  audit_id       TEXT,
  plugin_id      TEXT,
  change_id      TEXT,
  action_details TEXT NOT NULL,
  performed_by   TEXT NOT NULL,
  timestamp      TIMESTAMPTZ DEFAULT NOW(),
  metadata       JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_trail_business ON audit_trail(business_id);
CREATE INDEX IF NOT EXISTS idx_audit_trail_timestamp ON audit_trail(timestamp);

/* IMPLEMENTATION CHANGES */
CREATE TABLE IF NOT EXISTS implementation_changes (
  id              TEXT PRIMARY KEY,
  audit_id        UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  plugin_id       TEXT NOT NULL REFERENCES plugins(id),
  title           TEXT NOT NULL,
  priority        TEXT,
  impact_score    INT,
  description     TEXT,
  current_state   TEXT,
  proposed_change TEXT,
  change_type     TEXT,
  status          TEXT DEFAULT 'pending',
  user_edit       TEXT,
  location        TEXT,
  source_url      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

/* IMPLEMENTATION JOBS */
CREATE TABLE IF NOT EXISTS implementation_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id         UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  plugin_id        TEXT NOT NULL REFERENCES plugins(id),
  status           TEXT NOT NULL CHECK (status IN ('queued','deploying','completed','failed')),
  approved_changes JSONB NOT NULL,
  bot_response     JSONB,
  dispatched_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

/* SUB SERVICE PAGES */
CREATE TABLE IF NOT EXISTS sub_service_pages (
  audit_id          UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  slug              TEXT NOT NULL,
  service_name      TEXT NOT NULL,
  sub_service_name  TEXT NOT NULL,
  page_title        TEXT,
  meta_description  TEXT,
  status            TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  content_json      JSONB,
  rendered_html     TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (audit_id, slug)
);


