import { pool } from './db.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function initDatabase() {
  console.log('[PostgreSQL] Initializing database...');
  try {
    const schemaPath = resolve(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    // Run the schema.sql queries
    await pool.query(sql);
    
    // Check and add location and source_url columns to implementation_changes if they don't exist (migration)
    await pool.query(`
      ALTER TABLE implementation_changes ADD COLUMN IF NOT EXISTS location TEXT;
      ALTER TABLE implementation_changes ADD COLUMN IF NOT EXISTS source_url TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
      ALTER TABLE deployments ADD COLUMN IF NOT EXISTS builder_type TEXT;
      ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deployment_method TEXT;
      
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
    `);

    // ── Admin Panel migration (idempotent) ──────────────────────
    // Applied on every boot so the admin schema stays in sync without a
    // separate migrate step. The canonical SQL also lives at
    // db/migrations/001_admin_panel.sql for the standalone runner.
    await runAdminPanelMigration();

    console.log('[PostgreSQL] Database tables initialized successfully.');
  } catch (err) {
    console.error('[PostgreSQL] Database initialization failed:', err.message);
    // Do not crash the server in case PG is not accessible in some environments, but log warning
  }
}

// Reads and applies db/migrations/001_admin_panel.sql. Idempotent.
async function runAdminPanelMigration() {
  try {
    const migrationPath = resolve(__dirname, 'migrations', '001_admin_panel.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await pool.query(sql);
    console.log('[PostgreSQL] Admin-panel migration applied.');
  } catch (err) {
    console.error('[PostgreSQL] Admin-panel migration failed:', err.message);
  }
}
