// ============================================================
// backend/migrate-admin.js
// Standalone runner for the admin-panel migration.
// Usage: node backend/migrate-admin.js
// Mirrors the pattern in backend/migrate.js — idempotent.
// ============================================================
import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const isLocalhost = !process.env.DATABASE_URL ||
  process.env.DATABASE_URL.includes('localhost') ||
  process.env.DATABASE_URL.includes('127.0.0.1');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalhost ? false : { rejectUnauthorized: false }
});

async function migrate() {
  try {
    console.log('Running admin-panel migration...');
    const sqlPath = resolve(__dirname, 'db/migrations/001_admin_panel.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await pool.query(sql);
    console.log('Admin-panel migration completed successfully!');
  } catch (err) {
    console.error('Admin migration error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
