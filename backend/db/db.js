import pg from 'pg';
const { Pool } = pg;
import 'dotenv/config';

const isLocalhost = !process.env.DATABASE_URL || 
  process.env.DATABASE_URL.includes('localhost') || 
  process.env.DATABASE_URL.includes('127.0.0.1');

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalhost ? false : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('[PostgreSQL] Unexpected error on idle client', err);
  process.exit(-1);
});
