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
    console.log('[PostgreSQL] Database tables initialized successfully.');
  } catch (err) {
    console.error('[PostgreSQL] Database initialization failed:', err.message);
    // Do not crash the server in case PG is not accessible in some environments, but log warning
  }
}
