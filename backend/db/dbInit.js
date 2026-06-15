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
    `);

    console.log('[PostgreSQL] Database tables initialized successfully.');
  } catch (err) {
    console.error('[PostgreSQL] Database initialization failed:', err.message);
    // Do not crash the server in case PG is not accessible in some environments, but log warning
  }
}
